import { createServer } from 'node:http'
import { resolve } from 'node:path'
import express from 'express'
import helmet from 'helmet'
import { config } from './config.js'
import { db } from './db.js'
import { errors } from './errors.js'
import { accounts, auth, authenticate, readSession, verifyOrigin } from './auth.js'
import { cases } from './cases.js'
import { caseItems } from './case-items.js'
import { profiles } from './profiles.js'
import { documents } from './documents.js'
import { search } from './search.js'
import { administration, catalog } from './admin.js'
import { exports } from './exports.js'
import { attachCollaboration } from './collaboration.js'
import { subscribe } from './live.js'
import { visibleCase } from './access.js'
import { imageHosts } from './settings.js'
import { caseCharges, penalCode } from './charges.js'

const app = express()
app.disable('x-powered-by')
if (config.trustProxy) app.set('trust proxy', 1)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.production ? undefined : false,
    referrerPolicy: { policy: 'no-referrer' },
  }),
)
app.get('/api/health', async (_req, res) => {
  try {
    await db.$queryRaw`SELECT 1`
    res.json({ status: 'ok' })
  } catch {
    res.status(503).json({ status: 'unavailable' })
  }
})

const api = express.Router()
api.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})
api.use(verifyOrigin, express.json({ limit: '128kb' }))
api.use('/auth', auth)
api.use(authenticate)
api.use('/accounts', accounts)
api.use('/cases', cases, exports, caseCharges)
api.use('/penal-code', penalCode)
api.use('/cases/:id', caseItems)
api.use('/profiles', profiles)
api.use('/documents', documents)
api.use('/search', search)
api.use('/catalog', catalog)
api.use('/admin', administration)

const streams = new Set<express.Response>()
api.get('/events', (req, res) => {
  const identity = req.identity!
  res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  streams.add(res)
  res.write('event: ready\ndata: {}\n\n')
  let active = true
  const send = (event: string, data = {}) => {
    if (!active || res.destroyed) return
    if (!res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')) res.end()
  }
  const refresh = async (change?: Parameters<Parameters<typeof subscribe>[0]>[0]) => {
    if (change?.userId && change.userId !== identity.user.id) return
    if (change?.sessionId && change.sessionId !== identity.id) return
    const fresh = await readSession(identity.id)
    if (!fresh) {
      send('signed-out')
      res.end()
      return
    }
    if (!change) {
      send('heartbeat')
      return
    }
    if (change.caseId) {
      const canSee = await db.case.findFirst({
        where: { id: change.caseId, ...visibleCase(fresh.user) },
        select: { id: true },
      })
      if (!canSee) return
    }
    send('change', change.caseId ? { caseId: change.caseId } : {})
  }
  const stop = subscribe((change) => {
    void refresh(change).catch(() => res.end())
  })
  const timer = setInterval(() => {
    void refresh().catch(() => res.end())
  }, 15000)
  res.on('close', () => {
    active = false
    stop()
    clearInterval(timer)
    streams.delete(res)
  })
})
api.use((_req, res) => res.status(404).json({ error: 'Endpoint not found.' }))
app.use('/api', api)

const webRoot = resolve(config.webRoot)
app.use(
  '/assets',
  express.static(resolve(webRoot, 'assets'), {
    index: false,
    immutable: true,
    maxAge: '1y',
    redirect: false,
  }),
)
app.get('/{*path}', async (_req, res) => {
  const hosts = await imageHosts()
  const ws = config.origin.replace(/^http/, 'ws')
  const images = hosts.map((host) => 'https://' + host).join(' ')
  res.set('Cache-Control', 'no-store')
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "connect-src 'self' " + ws,
      "img-src 'self' " + images,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  )
  res.sendFile(resolve(webRoot, 'index.html'))
})
app.use(errors)

const server = createServer(app)
const stopCollaboration = attachCollaboration(server)
server.listen(config.port, config.host, () =>
  console.log('C.R.A.S.H. MDT listening on ' + config.host + ':' + config.port),
)
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
  for (const stream of streams) stream.end()
  try {
    await stopCollaboration()
    await stopped
  } catch (error) {
    console.error('Shutdown could not persist every pending document.', error)
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

import { Router, type Request, type RequestHandler, type Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import {
  id,
  masterUsername,
  password,
  requiredText,
  roles,
  text,
  username,
  version,
} from '../../packages/shared/validation.js'
import { config } from './config.js'
import { audit, db, publicUser, type Actor, type Database } from './db.js'
import { check, checkVersion } from './errors.js'
import { publish } from './live.js'
import { digest, hashPassword, token, verifyPassword } from './password.js'

const maxAge = 12 * 60 * 60 * 1000
const cookieOptions = {
  httpOnly: true,
  secure: config.production,
  sameSite: 'strict' as const,
  path: '/',
}
export type Identity = { id: string; csrf: string; user: Actor }
declare module 'express-serve-static-core' {
  interface Request {
    identity?: Identity
  }
}

function sessionId(header?: string | null) {
  const cookie = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(config.cookie + '='))
  const value = cookie?.slice(config.cookie.length + 1)
  return value && /^[\w-]{43}$/.test(value) ? digest(value) : undefined
}

export async function readSession(
  session: string | undefined,
  tx: Database = db,
): Promise<Identity | null> {
  if (!session) return null
  const entry = await tx.session.findFirst({
    where: {
      id: session,
      expiresAt: { gt: new Date() },
      user: { disabledAt: null, password: { not: null } },
    },
    select: { id: true, csrf: true, user: { select: publicUser } },
  })
  return entry
}

export function sessionFromCookie(header?: string | null) {
  return readSession(sessionId(header))
}

export const authenticate: RequestHandler = async (req, res, next) => {
  const identity = await sessionFromCookie(req.headers.cookie)
  if (!identity) {
    res.status(401).json({ error: 'Sign in to continue.' })
    return
  }
  req.identity = identity
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const supplied = Buffer.from(req.get('X-CSRF-Token') || '')
    const expected = Buffer.from(identity.csrf)
    check(
      supplied.length === expected.length && timingSafeEqual(supplied, expected),
      403,
      'Session verification failed. Reload and try again.',
    )
  }
  next()
}

export const verifyOrigin: RequestHandler = (req, _res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    check(req.get('Origin') === config.origin, 403, 'Request origin is not allowed.')
  }
  next()
}

export const actor = (req: Request) => req.identity!.user
export function canEdit(user: Actor) {
  return user.role !== 'VIEWER'
}
export function requireEditor(user: Actor) {
  check(canEdit(user), 403, 'Your account has read-only access.')
}
export function requireAdmin(user: Actor) {
  check(user.role === 'ADMIN', 403, 'Administrator access is required.')
}

export async function lockUser(tx: Database, userId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`
}
export async function lockIdentity(tx: Database, identity: Identity) {
  await lockUser(tx, identity.user.id)
  const fresh = await readSession(identity.id, tx)
  check(fresh, 401, 'Sign in to continue.')
  return fresh.user
}

async function createSession(res: Response, tx: Database, user: Actor) {
  const raw = token()
  const csrf = token()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + maxAge)
  await tx.session.deleteMany({ where: { userId: user.id, expiresAt: { lte: now } } })
  await tx.session.create({ data: { id: digest(raw), userId: user.id, csrf, expiresAt } })
  // The caller only sends this cookie after the transaction commits.
  return {
    send: () => res.cookie(config.cookie, raw, { ...cookieOptions, maxAge }),
    body: { user, csrf },
  }
}

const throttle = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
})
const loginThrottle = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const key = username.safeParse(req.body?.username)
    return key.success ? 'login:' + key.data : 'invalid-login'
  },
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
})
const invalidLogin = 'The username or password was not accepted.'
const invalidCode = 'This activation or reset code is invalid or has expired.'
export const auth = Router()

auth.post('/login', throttle, loginThrottle, async (req, res) => {
  const input = z.object({ username, password: z.string().min(1).max(128) }).safeParse(req.body)
  check(input.success, 401, invalidLogin)
  const account = await db.user.findUnique({
    where: { username: input.data.username },
    select: { ...publicUser, password: true, disabledAt: true },
  })
  const verified = await verifyPassword(input.data.password, account?.password)
  check(account && !account.disabledAt && verified, 401, invalidLogin)
  const session = await db.$transaction(async (tx) => {
    await lockUser(tx, account.id)
    const current = await tx.user.findUnique({
      where: { id: account.id },
      select: { password: true, disabledAt: true, username: true },
    })
    check(
      current &&
        !current.disabledAt &&
        current.password === account.password &&
        current.username === input.data.username,
      401,
      invalidLogin,
    )
    const previous = sessionId(req.headers.cookie)
    if (previous) await tx.session.deleteMany({ where: { id: previous } })
    const user = await tx.user.findUniqueOrThrow({ where: { id: account.id }, select: publicUser })
    return createSession(res, tx, user)
  })
  const previous = sessionId(req.headers.cookie)
  if (previous) publish({ sessionId: previous, disconnect: true })
  session.send()
  res.json(session.body)
})

auth.post('/activate', throttle, async (req, res) => {
  const input = z.object({ code: text(100), password }).parse(req.body)
  check(/^[\w-]{43}$/.test(input.code), 400, invalidCode)
  const where = { digest: digest(input.code) }
  const credential = await db.credential.findUnique({ where })
  check(credential && credential.expiresAt > new Date(), 400, invalidCode)
  const hash = await hashPassword(input.password)
  const session = await db.$transaction(async (tx) => {
    await lockUser(tx, credential.userId)
    const account = await tx.user.findUnique({ where: { id: credential.userId } })
    check(account && !account.disabledAt && account.username !== masterUsername, 400, invalidCode)
    check(credential.kind === 'RESET' ? account.password : !account.password, 400, invalidCode)
    const used = await tx.credential.deleteMany({ where: { ...where, expiresAt: { gt: new Date() } } })
    check(used.count === 1, 400, invalidCode)
    const user = await tx.user.update({
      where: { id: account.id },
      data: { password: hash },
      select: publicUser,
    })
    const previous = sessionId(req.headers.cookie)
    await tx.session.deleteMany({
      where: { OR: [{ userId: user.id }, ...(previous ? [{ id: previous }] : [])] },
    })
    await tx.credential.deleteMany({ where: { userId: user.id } })
    await audit(
      tx,
      user.id,
      credential.kind === 'RESET' ? 'account.password_reset' : 'account.activated',
      'user',
      user.id,
    )
    return createSession(res, tx, user)
  })
  const previous = sessionId(req.headers.cookie)
  if (previous) publish({ sessionId: previous, disconnect: true })
  publish({ userId: session.body.user.id, disconnect: true })
  session.send()
  res.json(session.body)
})

auth.get('/session', authenticate, (req, res) => {
  const { user, csrf } = req.identity!
  res.json({ user, csrf })
})

auth.post('/logout', authenticate, async (req, res) => {
  await db.session.deleteMany({ where: { id: req.identity!.id } })
  publish({ sessionId: req.identity!.id, disconnect: true })
  res.clearCookie(config.cookie, cookieOptions).sendStatus(204)
})

auth.post('/password', authenticate, throttle, async (req, res) => {
  const input = z
    .object({
      current: z.string().min(1).max(128),
      password,
    })
    .parse(req.body)
  const userId = actor(req).id
  const saved = await db.user.findUnique({ where: { id: userId }, select: { password: true } })
  const verified = await verifyPassword(input.current, saved?.password)
  check(verified, 422, 'The current password was not accepted.')
  check(input.current !== input.password, 422, 'Choose a different password.')
  const hash = await hashPassword(input.password)
  await db.$transaction(async (tx) => {
    await lockIdentity(tx, req.identity!)
    const latest = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { password: true },
    })
    check(latest.password === saved?.password, 409, 'The password has already changed. Sign in again.')
    await tx.user.update({ where: { id: userId }, data: { password: hash } })
    await tx.session.deleteMany({ where: { userId } })
    await tx.credential.deleteMany({ where: { userId } })
    await audit(tx, userId, 'account.password_changed', 'user', userId)
  })
  publish({ userId, disconnect: true })
  res.clearCookie(config.cookie, cookieOptions).sendStatus(204)
})

auth.get('/sessions', authenticate, async (req, res) => {
  const count = await db.session.count({
    where: {
      userId: actor(req).id,
      expiresAt: { gt: new Date() },
      id: { not: req.identity!.id },
    },
  })
  res.json({ otherSessions: count })
})

auth.delete('/sessions', authenticate, async (req, res) => {
  const userId = actor(req).id
  const removed = await db.$transaction(async (tx) => {
    await lockIdentity(tx, req.identity!)
    const where = { userId, id: { not: req.identity!.id } }
    const sessions = await tx.session.findMany({ where, select: { id: true } })
    await tx.session.deleteMany({ where })
    await audit(tx, userId, 'account.other_sessions_revoked', 'user', userId, {
      count: sessions.length,
    })
    return sessions
  })
  for (const session of removed) publish({ sessionId: session.id, disconnect: true })
  publish({ userId })
  res.sendStatus(204)
})

const profile = z.object({
  username,
  displayName: requiredText(140),
  badge: text(48).nullable().default(null),
  role: z.enum(roles),
})

async function issue(tx: Database, userId: string, kind: 'ACTIVATION' | 'RESET') {
  const code = token()
  const expiresAt = new Date(Date.now() + (kind === 'ACTIVATION' ? 24 : 1) * 60 * 60 * 1000)
  await tx.credential.deleteMany({ where: { userId } })
  await tx.credential.create({ data: { userId, kind, digest: digest(code), expiresAt } })
  return { code, expiresAt }
}

export const accounts = Router()
accounts.use((req, _res, next) => {
  requireAdmin(actor(req))
  next()
})
accounts.get('/', async (req, res) => {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(req.query.page ?? 1)
  const q = text(100).parse(req.query.q ?? '')
  const where = {
    OR: [
      { username: { contains: q, mode: 'insensitive' as const } },
      { displayName: { contains: q, mode: 'insensitive' as const } },
    ],
  }
  const users = await db.user.findMany({
    where,
    orderBy: [{ username: 'asc' }, { id: 'asc' }],
    skip: (page - 1) * 30,
    take: 31,
    select: { ...publicUser, disabledAt: true, createdAt: true, password: true, version: true },
  })
  res.json({
    items: users.slice(0, 30).map(({ password, ...user }) => ({ ...user, activated: !!password })),
    more: users.length > 30,
  })
})

accounts.post('/', async (req, res) => {
  const input = profile.parse(req.body)
  check(input.username !== masterUsername, 409, 'This username is reserved.')
  const result = await db.$transaction(async (tx) => {
    const operator = await lockIdentity(tx, req.identity!)
    requireAdmin(operator)
    check(
      input.role !== 'ADMIN' || operator.username === masterUsername,
      403,
      'Only mercia can grant administrator access.',
    )
    const user = await tx.user.create({ data: input, select: publicUser })
    const credential = await issue(tx, user.id, 'ACTIVATION')
    await audit(tx, operator.id, 'account.provisioned', 'user', user.id, {
      username: user.username,
      role: user.role,
    })
    return { user, ...credential }
  })
  publish()
  res.status(201).json(result)
})

async function managedAccount(
  tx: Database,
  req: Request,
  userId: string,
  requestedRole?: Actor['role'],
) {
  for (const lockId of [...new Set([actor(req).id, userId])].sort()) await lockUser(tx, lockId)
  const current = await readSession(req.identity!.id, tx)
  check(current, 401, 'Sign in to continue.')
  const operator = current.user
  requireAdmin(operator)
  const target = await tx.user.findUnique({ where: { id: userId } })
  check(target, 404, 'Account not found.')
  check(target.username !== masterUsername, 403, 'The master account is protected.')
  check(target.id !== operator.id, 403, 'Ask another administrator to manage your account.')
  check(
    (target.role !== 'ADMIN' && requestedRole !== 'ADMIN') || operator.username === masterUsername,
    403,
    'Only mercia can manage administrator privileges and credentials.',
  )
  return { operator, target }
}

accounts.patch('/:id', async (req, res) => {
  const userId = id.parse(req.params.id)
  const { version: expected, ...input } = profile.extend({ version }).parse(req.body)
  check(input.username !== masterUsername, 409, 'This username is reserved.')
  const revoke = await db.$transaction(async (tx) => {
    const { operator, target } = await managedAccount(tx, req, userId, input.role)
    checkVersion(target.version, expected)
    await tx.user.update({ where: { id: userId }, data: { ...input, version: { increment: 1 } } })
    const credentialsChanged = target.username !== input.username || target.role !== input.role
    if (credentialsChanged) {
      await tx.session.deleteMany({ where: { userId } })
      await tx.credential.deleteMany({ where: { userId } })
    }
    await audit(tx, operator.id, 'account.edited', 'user', userId, {
      before: {
        username: target.username,
        displayName: target.displayName,
        badge: target.badge,
        role: target.role,
      },
      after: input,
    })
    return credentialsChanged
  })
  if (revoke) publish({ userId, disconnect: true })
  publish()
  res.sendStatus(204)
})

accounts.delete('/:id', async (req, res) => {
  const userId = id.parse(req.params.id)
  const input = z.object({ version, confirmation: requiredText(48) }).parse(req.body)
  await db.$transaction(async (tx) => {
    const { operator, target } = await managedAccount(tx, req, userId)
    checkVersion(target.version, input.version)
    check(input.confirmation === target.username, 422, 'Enter the username to confirm deletion.')
    await tx.$executeRaw`UPDATE "Case" SET version = version + 1
      WHERE "leadId" = ${userId} OR id IN (SELECT "caseId" FROM "CaseMember" WHERE "userId" = ${userId})
        OR id IN (SELECT "caseId" FROM "CasePerson" WHERE "userId" = ${userId})`
    await tx.task.updateMany({
      where: { assigneeId: userId },
      data: { assigneeId: null, version: { increment: 1 } },
    })
    await tx.user.delete({ where: { id: userId } })
    await audit(tx, operator.id, 'account.deleted', 'user', userId, {
      username: target.username,
      role: target.role,
    })
  })
  publish({ userId, disconnect: true })
  publish()
  res.sendStatus(204)
})

accounts.post('/:id/action', async (req, res) => {
  const userId = id.parse(req.params.id)
  const input = z
    .discriminatedUnion('action', [
      z.object({ action: z.literal('role'), role: z.enum(roles) }),
      z.object({ action: z.enum(['disable', 'enable', 'revoke', 'issue']) }),
    ])
    .parse(req.body)
  const result = await db.$transaction(async (tx) => {
    const { operator, target } = await managedAccount(
      tx,
      req,
      userId,
      input.action === 'role' ? input.role : undefined,
    )
    if (input.action === 'issue') {
      check(!target.disabledAt, 409, 'Reactivate the account before issuing a code.')
      const kind = target.password ? 'RESET' : 'ACTIVATION'
      const code = await issue(tx, userId, kind)
      await audit(tx, operator.id, 'account.code_issued', 'user', userId, { kind })
      return code
    }
    if (input.action === 'role')
      await tx.user.update({
        where: { id: userId },
        data: { role: input.role, version: { increment: 1 } },
      })
    if (input.action === 'disable' || input.action === 'enable') {
      await tx.user.update({
        where: { id: userId },
        data: { disabledAt: input.action === 'disable' ? new Date() : null, version: { increment: 1 } },
      })
      if (input.action === 'disable') await tx.credential.deleteMany({ where: { userId } })
    }
    if (input.action === 'role') await tx.credential.deleteMany({ where: { userId } })
    if (input.action !== 'enable') await tx.session.deleteMany({ where: { userId } })
    await audit(
      tx,
      operator.id,
      'account.' + input.action,
      'user',
      userId,
      input.action === 'role' ? { from: target.role, to: input.role } : undefined,
    )
    return { ok: true }
  })
  publish(input.action === 'issue' || input.action === 'enable' ? {} : { userId, disconnect: true })
  res.json(result)
})

import type { Server } from 'node:http'
import { Hocuspocus, type Document } from '@hocuspocus/server'
import { WebSocketServer, type WebSocket } from 'ws'
import * as Y from 'yjs'
import { z } from 'zod'
import { documentField } from '../../packages/shared/rich-text.js'
import { documentAccessChanged, invalidDocumentUpdate } from '../../packages/shared/durability.js'
import { id } from '../../packages/shared/validation.js'
import { config } from './config.js'
import { isCaseEditor, lockCase, visibleCase } from './access.js'
import { readSession, sessionFromCookie } from './auth.js'
import { db, type Actor } from './db.js'
import { maxDocumentBytes, readDocument } from './document-state.js'
import { imageHosts } from './settings.js'
import { publish, subscribe } from './live.js'
import { enterCaseGate } from './gates.js'

type Context = { room: string; caseId: string; session: string; user: Actor; presenceId?: number }
const expired = { code: 4403, reason: documentAccessChanged }
const invalid = { code: 4400, reason: invalidDocumentUpdate }
const rooms = z.tuple([id, z.coerce.number().int().positive().max(2147483647)])
const color = ['#e3bc78', '#84c2d6', '#c2a8e2', '#91c39b', '#ea9a9a']

export function roomName(documentId: string, epoch: number) {
  return documentId + '.' + epoch
}
function roomParts(room: string) {
  const parsed = rooms.safeParse(room.split('.'))
  if (!parsed.success) throw expired
  return parsed.data
}

async function access(room: string, user: Actor) {
  const [id, epoch] = roomParts(room)
  const record = await db.document.findFirst({
    where: { id, epoch, removedAt: null, case: visibleCase(user) },
    select: { caseId: true, case: { select: { statusId: true } } },
  })
  if (!record) throw expired
  return { caseId: record.caseId, writable: isCaseEditor(user, record.case.statusId) }
}

const failures = new Map<string, ReturnType<typeof setTimeout>>()
let stopping = false
export function storageFailed(room: string) {
  return failures.has(room)
}

async function persist(room: string, document: Document) {
  const [id, epoch] = roomParts(room)
  const target = await db.document.findUnique({ where: { id }, select: { caseId: true } })
  if (!target) return
  const changed = await db.$transaction(async (tx) => {
    await lockCase(tx, target.caseId)
    const record = await tx.document.findFirst({
      where: { id, epoch, removedAt: null, case: { statusId: { notIn: ['closed', 'archived'] } } },
      select: { stateHash: true, caseId: true },
    })
    if (!record) return false
    const { json: _json, ...data } = readDocument(document)
    if (record.stateHash === data.stateHash) return false
    await tx.document.update({ where: { id }, data })
    await tx.case.update({ where: { id: record.caseId }, data: { updatedAt: new Date() } })
    const since = new Date(Date.now() - 15 * 60 * 1000)
    const recent = await tx.revision.findFirst({
      where: { documentId: id, createdAt: { gt: since } },
      select: { id: true },
    })
    if (!recent)
      await tx.revision.create({
        data: { ...data, documentId: id, kind: 'PERIODIC', label: 'Autosave snapshot' },
      })
    return true
  })
  if (changed) publish({ caseId: target.caseId })
}

async function persistWithRetry(room: string, document: Document) {
  try {
    await persist(room, document)
    clearTimeout(failures.get(room))
    failures.delete(room)
  } catch (error) {
    clearTimeout(failures.get(room))
    if (!stopping) {
      failures.set(
        room,
        setTimeout(() => {
          void persistWithRetry(room, document).catch(() => undefined)
        }, 2500),
      )
    }
    throw error
  }
}

const relativeId = z
  .object({ client: z.number().int().nonnegative(), clock: z.number().int().nonnegative() })
  .strict()
const position = z
  .object({
    type: relativeId.nullable().optional(),
    item: relativeId.nullable().optional(),
    tname: z.literal(documentField).nullable().optional(),
    assoc: z.number().int().min(-1).max(1).optional(),
  })
  .strict()
const caret = z.object({ anchor: position, head: position }).strict()
const presenceOwners = new WeakMap<Document, Map<number, string>>()
const gates = new WeakMap<object, () => void>()

export const collaboration = new Hocuspocus<Context>({
  debounce: 500,
  maxDebounce: 2000,
  timeout: 65000,
  maxPendingDocuments: 1,
  async onAuthenticate({ context, documentName, connectionConfig }) {
    if (stopping || documentName !== context.room) throw expired
    const current = await readSession(context.session)
    if (!current) throw expired
    connectionConfig.readOnly = !(await access(documentName, current.user)).writable
    return { ...context, user: current.user }
  },
  async onLoadDocument({ documentName, document }) {
    const [id, epoch] = roomParts(documentName)
    const record = await db.document.findFirst({
      where: { id, epoch, removedAt: null },
      select: { state: true },
    })
    if (!record) throw expired
    document.getXmlFragment(documentField)
    Y.applyUpdate(document, record.state)
  },
  async beforeHandleMessage({ context, documentName, connection }) {
    const release = await enterCaseGate(context.caseId)
    try {
      const current = await readSession(context.session)
      if (!current) throw expired
      const allowed = await access(documentName, current.user)
      if (connection.readOnly === allowed.writable) throw expired
      gates.set(connection, release)
    } catch (error) {
      release()
      throw error
    }
  },
  async afterHandleMessage({ connection }) {
    gates.get(connection)?.()
    gates.delete(connection)
  },
  async beforeSync({ document, connection, type, payload }) {
    if (type === 0 || connection.readOnly || payload.length <= 2) return
    const hosts = await imageHosts()
    const candidate = new Y.Doc()
    try {
      candidate.getXmlFragment(documentField)
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
      Y.applyUpdate(candidate, payload)
      if (candidate.store.pendingStructs || candidate.store.pendingDs) throw invalid
      readDocument(candidate, { hosts, previous: document })
    } catch {
      throw invalid
    } finally {
      candidate.destroy()
    }
  },
  async beforeHandleAwareness({ context, document, socketId, states, removedClients }) {
    if (!context) {
      states.clear()
      removedClients.clear()
      return
    }
    let owners = presenceOwners.get(document)
    if (!owners) {
      owners = new Map()
      presenceOwners.set(document, owners)
    }
    for (const [client, incoming] of states) {
      if (
        (context.presenceId !== undefined && client !== context.presenceId) ||
        (owners.has(client) && owners.get(client) !== socketId)
      ) {
        states.delete(client)
        continue
      }
      context.presenceId = client
      owners.set(client, socketId)
      const cursor = caret.safeParse(incoming.cursor)
      const seed = parseInt(context.user.id.slice(0, 4), 16) % color.length
      states.set(client, {
        user: { name: context.user.displayName, color: color[seed], id: context.user.id },
        cursor: cursor.success ? cursor.data : null,
      })
    }
    for (const client of removedClients)
      if (owners.get(client) !== socketId) removedClients.delete(client)
  },
  async onDisconnect({ document, context, socketId }) {
    const client = context.presenceId
    const owners = presenceOwners.get(document)
    if (client !== undefined && owners?.get(client) === socketId) owners.delete(client)
  },
  async onStoreDocument({ document, documentName }) {
    if (!stopping) await persistWithRetry(documentName, document)
  },
})

type SocketEntry = { caseId: string; userId: string; session: string; room: string }
export function attachCollaboration(http: Server) {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: maxDocumentBytes + 8192,
    perMessageDeflate: false,
  })
  const sockets = new Map<WebSocket, SocketEntry>()
  const closeAffected = subscribe((change) => {
    if (!change.disconnect) return
    for (const [socket, entry] of sockets) {
      if (
        (change.documentId && entry.room.startsWith(change.documentId + '.')) ||
        (!change.documentId && change.caseId && entry.caseId === change.caseId) ||
        (change.userId && entry.userId === change.userId) ||
        (change.sessionId && entry.session === change.sessionId)
      ) {
        socket.close(expired.code, expired.reason)
      }
    }
  })
  const validate = setInterval(() => {
    for (const [socket, entry] of sockets) {
      if (socket.readyState !== socket.OPEN) continue
      socket.ping()
      void readSession(entry.session)
        .then(async (identity) => {
          if (!identity) throw expired
          await access(entry.room, identity.user)
        })
        .catch(() => socket.close(expired.code, expired.reason))
    }
  }, 10000)
  validate.unref()

  http.on('upgrade', (incoming, socket, head) => {
    socket.on('error', () => socket.destroy())
    void (async () => {
      const requestUrl = new URL(incoming.url ?? '/', config.origin)
      if (
        stopping ||
        requestUrl.pathname !== '/collaboration' ||
        incoming.headers.origin !== config.origin
      )
        throw expired
      const identity = await sessionFromCookie(incoming.headers.cookie)
      if (!identity) throw expired
      const room = requestUrl.searchParams.get('room') ?? ''
      const allowed = await access(room, identity.user)
      const accountSockets = [...sockets.values()].filter(
        (entry) => entry.userId === identity.user.id,
      ).length
      if (stopping || accountSockets >= 40 || sockets.size >= 240) throw expired
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      server.handleUpgrade(incoming, socket, head, (ws) => {
        sockets.set(ws, { ...allowed, userId: identity.user.id, session: identity.id, room })
        const connection = collaboration.handleConnection(ws, new Request(requestUrl, { headers }), {
          room,
          caseId: allowed.caseId,
          session: identity.id,
          user: identity.user,
        })
        ws.on('message', (data) => {
          if (stopping) return
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : data
          connection.handleMessage(bytes)
        })
        ws.on('pong', () => connection.touch())
        ws.on('close', (code, reason) => {
          sockets.delete(ws)
          connection.handleClose({ code, reason: reason.toString() })
        })
        ws.on('error', () => ws.terminate())
      })
    })().catch((error) => {
      if (process.env.TEST_DEBUG) console.error('Upgrade rejected', error)
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
  })

  return async () => {
    stopping = true
    closeAffected()
    clearInterval(validate)
    for (const timer of failures.values()) clearTimeout(timer)
    const open = [...collaboration.documents]
    try {
      await Promise.all(
        open.flatMap(([, doc]) =>
          doc.getConnections().map((connection) => connection.waitForPendingMessages()),
        ),
      )
      await Promise.all(open.map(([room, document]) => persist(room, document)))
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        for (const socket of sockets.keys()) socket.terminate()
      })
    }
  }
}

export function checkNoPending(room: string, durableHash: string) {
  const open = collaboration.documents.get(room)
  return !open || readDocument(open).stateHash === durableHash
}

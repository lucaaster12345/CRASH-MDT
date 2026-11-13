import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import {
  account,
  Client,
  exec,
  issuedPassword,
  kill,
  masterPassword,
  provision,
  start,
  testDatabase,
  until,
} from './fixtures.js'
import type { Actor } from '../apps/server/db.js'
import type { CaseRecord, DocumentRecord, Durable, Page, ProfileRecord } from '../apps/web/src/types.js'
import type { Account, Charge, Packet } from '../apps/web/src/types.js'
import type { ChargeReport } from '../apps/web/src/charges.js'
import { durabilityProof } from '../packages/shared/durability.js'

const origin = 'http://127.0.0.1:38507'
process.env.DATABASE_URL = testDatabase()
const { db } = await import('../apps/server/db.js')
const admin = new Client(origin)
const anonymous = new Client(origin)
let server: ChildProcess
let writer: Awaited<ReturnType<typeof provision>>
let partner: Awaited<ReturnType<typeof provision>>
let viewer: Awaited<ReturnType<typeof provision>>
let publicCase: CaseRecord
let privateCase: CaseRecord
let documentId: string
const editorCleanups = new Set<() => void>()

before(async () => {
  await db.$executeRaw`TRUNCATE "User", "Profile", "Case", "Tag", "Audit", "Setting", "PenalCharge" RESTART IDENTITY CASCADE`
  await account(origin, 'bootstrap', masterPassword)
  server = await start(origin)
})
after(async () => {
  for (const cleanup of editorCleanups) cleanup()
  if (server) await kill(server)
  await db.$disconnect()
})

async function openCase(client: Client, title: string, extra: object = {}) {
  const { id } = await client.call<{ id: string }>('/cases', 'POST', { title, ...extra }, 201)
  return client.call<CaseRecord>('/cases/' + id)
}
const documentPath = () => '/documents/' + documentId

function connect(client: Client, id: string, epoch: number, doc = new Y.Doc(), requestOrigin = origin) {
  const room = id + '.' + epoch
  class AuthWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { Cookie: client.cookie, Origin: requestOrigin } })
      if (process.env.TEST_DEBUG) {
        this.on('open', () => console.log('Test WebSocket opened'))
        this.on('message', (data) =>
          console.log(
            'Test WebSocket frame received',
            Array.isArray(data) ? data.length : data.byteLength,
          ),
        )
        this.on('close', (code, reason) =>
          console.log('Test WebSocket closed', code, reason.toString()),
        )
        this.on('error', (error) => console.log('Test WebSocket error', error.message))
      }
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: origin.replace('http', 'ws') + '/collaboration?room=' + room,
    WebSocketPolyfill: AuthWebSocket,
    minDelay: 100,
    delay: 100,
    maxDelay: 500,
  })
  let synced = false
  let closed = false
  const provider = new HocuspocusProvider({
    name: room,
    websocketProvider: socket,
    document: doc,
    onSynced: ({ state }) => {
      synced = state
    },
    onClose: () => {
      closed = true
    },
    onAuthenticationFailed: ({ reason }) => {
      if (process.env.TEST_DEBUG) console.log('Document authentication rejected', reason)
    },
  })
  provider.attach()
  const stop = () => {
    provider.destroy()
    socket.destroy()
    editorCleanups.delete(stop)
  }
  editorCleanups.add(stop)
  return { doc, provider, stop, synced: () => synced, closed: () => closed }
}

function addParagraph(doc: Y.Doc, content: string) {
  doc.transact(() => {
    const element = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    text.insert(0, content)
    element.insert(0, [text])
    doc.getXmlFragment('default').push([element])
  })
}
const docText = (doc: Y.Doc) => JSON.stringify(yDocToProsemirrorJSON(doc, 'default'))
const stateHash = (doc: Y.Doc) => createHash('sha256').update(durabilityProof(doc)).digest('hex')

test('bootstrap is idempotent, accounts are issued, CSRF and single-use credentials are enforced', async () => {
  assert.match(await account(origin, 'bootstrap', 'Fixture alternative password'), /already exists/)
  await anonymous.call('/cases/' + randomBytes(16).toString('hex'), 'GET', undefined, 401)
  await anonymous.call('/auth/register', 'POST', {}, 401)
  await anonymous.call(
    '/auth/login',
    'POST',
    { username: 'mercia', password: masterPassword },
    403,
    true,
  )
  await anonymous.call(
    '/auth/login',
    'POST',
    { username: 'mercia', password: 'Fixture alternative password' },
    401,
  )
  const master = await admin.call<{ user: Actor }>('/auth/login', 'POST', {
    username: 'mercia',
    password: masterPassword,
  })
  assert.equal(master.user.role, 'ADMIN')
  const forged = new Client(origin)
  forged.cookie = admin.cookie
  await forged.call('/cases', 'POST', { title: 'Blocked by CSRF' }, 403)
  await admin.call('/accounts/' + master.user.id + '/action', 'POST', { action: 'disable' }, 403)
  writer = await provision(admin, 'INVESTIGATOR', 'Fictional Investigator')
  partner = await provision(admin, 'INVESTIGATOR', 'Fictional Partner')
  viewer = await provision(admin, 'VIEWER', 'Fictional Viewer')
  await anonymous.call('/auth/activate', 'POST', { code: writer.code, password: issuedPassword }, 400)
  const delegated = await provision(admin, 'ADMIN', 'Fictional Administrator')
  await delegated.client.call(
    '/accounts/' + writer.user.id + '/action',
    'POST',
    { action: 'role', role: 'ADMIN' },
    403,
  )
  await delegated.client.call(
    '/accounts/' + master.user.id + '/action',
    'POST',
    { action: 'role', role: 'VIEWER' },
    403,
  )
  const reset = await admin.call<{ code: string }>('/accounts/' + viewer.user.id + '/action', 'POST', {
    action: 'issue',
  })
  await db.credential.updateMany({
    where: { userId: viewer.user.id },
    data: { expiresAt: new Date(0) },
  })
  await anonymous.call('/auth/activate', 'POST', { code: reset.code, password: issuedPassword }, 400)
  const replacement = await admin.call<{ code: string }>(
    '/accounts/' + viewer.user.id + '/action',
    'POST',
    { action: 'issue' },
  )
  const oldSession = viewer.client.cookie
  await viewer.client.call('/auth/activate', 'POST', {
    code: replacement.code,
    password: issuedPassword,
  })
  const revoked = new Client(origin)
  revoked.cookie = oldSession
  await revoked.call('/auth/session', 'GET', undefined, 401)
  await anonymous.call(
    '/auth/activate',
    'POST',
    { code: replacement.code, password: issuedPassword },
    400,
  )
})

test('case permissions cover search, profile appearances, related links, exports and dashboards', async () => {
  publicCase = await openCase(writer.client, 'Fictional Rail Yard Inquiry', { leadId: writer.user.id })
  privateCase = await openCase(writer.client, 'Privileged Saffron file', {
    leadId: writer.user.id,
    memberIds: [partner.user.id],
    restricted: true,
    summary: 'Protected Orchid incident',
  })
  documentId = privateCase.documents.find((doc) => doc.type === 'INCIDENT')!.id
  await viewer.client.call('/cases', 'POST', { title: 'Disallowed' }, 403)
  await viewer.client.call('/cases/' + privateCase.id, 'GET', undefined, 404)
  await viewer.client.call(documentPath(), 'GET', undefined, 404)
  await viewer.client.call(
    '/cases/' + privateCase.id + '/export',
    'POST',
    { documents: [], evidence: true, tasks: true },
    404,
  )
  const forbiddenRoom = connect(viewer.client, documentId, privateCase.documents[0]!.epoch)
  await until(forbiddenRoom.closed, 'Unassigned viewer WebSocket rejected')
  assert.equal(forbiddenRoom.synced(), false)
  forbiddenRoom.stop()
  const profile = await writer.client.call<{ id: string }>(
    '/profiles',
    'POST',
    {
      fullName: 'Fictional Alex Reed',
      aliases: ['Mistral'],
      identifier: 'ID-RD-29',
    },
    201,
  )
  await writer.client.call(
    '/cases/' + privateCase.id + '/persons',
    'POST',
    {
      role: 'SUSPECT',
      name: 'Alex R.',
      profileId: profile.id,
      version: privateCase.version,
    },
    201,
  )
  await writer.client.call(
    '/cases/' + publicCase.id + '/related',
    'POST',
    {
      toId: privateCase.id,
      explanation: 'Overlapping inquiries',
      version: publicCase.version,
    },
    204,
  )
  const visible = await viewer.client.call<CaseRecord>('/cases/' + publicCase.id)
  assert.deepEqual(visible.links, [])
  const safeProfile = await viewer.client.call<ProfileRecord>('/profiles/' + profile.id)
  assert.deepEqual(safeProfile.appearances, [])
  for (const term of ['Saffron', 'Mistral', 'Orchid', privateCase.number]) {
    const results = await viewer.client.call<Page<CaseRecord>>(
      '/search/cases?q=' + encodeURIComponent(term),
    )
    assert.deepEqual(results, { items: [], more: false })
  }
  const dashboard = await viewer.client.call('/search/dashboard')
  assert.ok(!JSON.stringify(dashboard).includes(privateCase.title))
  const packet = await viewer.client.call('/cases/' + publicCase.id + '/export', 'POST', {
    documents: [],
    evidence: true,
    tasks: true,
  })
  assert.ok(!JSON.stringify(packet).includes(privateCase.title))
  privateCase = await admin.call<CaseRecord>('/cases/' + privateCase.id)
  publicCase = await admin.call<CaseRecord>('/cases/' + publicCase.id)
})

test('two authorized editors persist and reconnect, direct viewer writes are ignored, saved content survives a kill', async () => {
  const initial = await writer.client.call<DocumentRecord>(documentPath())
  const base = '/cases/' + privateCase.id
  await writer.client.call(
    base + '/status',
    'POST',
    { version: privateCase.version, action: 'move', status: 'active' },
    409,
  )
  await writer.client.call(
    documentPath() + '/history',
    'POST',
    { action: 'submit', epoch: initial.epoch, stateHash: initial.stateHash },
    422,
  )
  const a = connect(writer.client, documentId, initial.epoch)
  const b = connect(partner.client, documentId, initial.epoch)
  await until(() => a.synced() && b.synced(), 'Initial editor synchronization')
  a.provider.setAwarenessField('user', { name: 'Impersonated identity', color: 'red' })
  await until(
    () =>
      [...b.provider.awareness!.getStates().values()].some(
        (state) => state.user?.name === 'Fictional Investigator',
      ),
    'Trusted awareness',
  )
  addParagraph(a.doc, 'Saffron witnesses observed a blue van leaving the rail depot.')
  addParagraph(b.doc, 'An officer logged the vehicle description in the evening.')
  await until(
    () => docText(a.doc).includes('vehicle description') && docText(b.doc).includes('blue van'),
    'Concurrent paragraphs',
  )
  b.stop()
  addParagraph(b.doc, 'A disconnected partner recorded the checkpoint sequence.')
  const returning = connect(partner.client, documentId, initial.epoch, b.doc)
  await until(
    () => returning.synced() && docText(a.doc).includes('checkpoint sequence'),
    'Reconnect merge',
  )
  assert.equal(docText(a.doc).match(/checkpoint sequence/g)?.length, 1)
  await until(
    async () =>
      (await writer.client.call<Durable>(documentPath() + '/durable')).stateHash === stateHash(a.doc),
    'Durable hash',
  )
  const hash = stateHash(a.doc)

  const publicDoc = publicCase.documents[0]!
  const readonly = connect(viewer.client, publicDoc.id, publicDoc.epoch)
  await until(readonly.synced, 'Viewer synchronizes')
  assert.equal(readonly.provider.authorizedScope, 'readonly')
  addParagraph(readonly.doc, 'Viewer tried to write directly.')
  await delay(900)
  const unchanged = await admin.call<Durable>('/documents/' + publicDoc.id + '/durable')
  assert.equal(unchanged.stateHash, publicDoc.stateHash)
  await viewer.client.call(
    '/documents/' + publicDoc.id + '/history',
    'POST',
    { action: 'checkpoint', label: 'Blocked', epoch: publicDoc.epoch, stateHash: publicDoc.stateHash },
    403,
  )
  const wrongOrigin = connect(
    writer.client,
    documentId,
    initial.epoch,
    new Y.Doc(),
    'http://127.0.0.1:38508',
  )
  await delay(350)
  assert.equal(wrongOrigin.synced(), false)
  wrongOrigin.stop()

  a.stop()
  returning.stop()
  readonly.stop()
  await kill(server)
  server = await start(origin)
  const durable = await writer.client.call<Durable>(documentPath() + '/durable')
  assert.equal(durable.stateHash, hash)
  const reloaded = connect(writer.client, documentId, initial.epoch)
  await until(reloaded.synced, 'Reloaded saved state')
  assert.match(docText(reloaded.doc), /blue van/)
  assert.match(docText(reloaded.doc), /vehicle description/)
  assert.equal(docText(reloaded.doc).match(/checkpoint sequence/g)?.length, 1)
  reloaded.stop()
  const malformed = connect(writer.client, documentId, initial.epoch)
  await until(malformed.synced, 'Validation test editor sync')
  const image = new Y.XmlElement('image')
  image.setAttribute('src', 'javascript:alert(1)')
  malformed.doc.getXmlFragment('default').push([image])
  await until(malformed.closed, 'Unsafe collaborative image rejected')
  assert.equal((await writer.client.call<Durable>(documentPath() + '/durable')).stateHash, hash)
  malformed.stop()
  const matched = await writer.client.call<Page<CaseRecord>>('/search/cases?q=checkpoint%20sequence')
  assert.equal(matched.items[0]?.id, privateCase.id)
  await writer.client.call(
    documentPath() + '/history',
    'POST',
    { action: 'submit', epoch: initial.epoch, stateHash: hash },
    204,
  )
  await writer.client.call(
    base + '/status',
    'POST',
    { version: privateCase.version, action: 'move', status: 'active' },
    204,
  )
  privateCase = await writer.client.call<CaseRecord>(base)
})

test('version conflicts, lifecycle changes, and revision restore preserve durable history', async () => {
  const route = '/cases/' + privateCase.id
  const old = privateCase.version
  const update = {
    title: privateCase.title,
    summary: 'Revised summary',
    restricted: true,
    leadId: writer.user.id,
    memberIds: [partner.user.id],
    version: old,
  }
  await writer.client.call(route, 'PATCH', update, 204)
  await writer.client.call(route, 'PATCH', { ...update, title: 'Stale title' }, 409)
  const original = await writer.client.call<DocumentRecord>(documentPath())
  const checkpoint = {
    action: 'checkpoint',
    label: 'Before review',
    epoch: original.epoch,
    stateHash: original.stateHash,
  }
  await writer.client.call(documentPath() + '/history', 'POST', checkpoint, 204)
  const revisions = await writer.client.call<Page<{ id: string; label: string }>>(
    documentPath() + '/history',
  )
  const saved = revisions.items.find((item) => item.label === 'Before review')!
  const open = connect(partner.client, documentId, original.epoch)
  await until(open.synced, 'Editor opened for revision test')
  addParagraph(open.doc, 'An amendment requires a new review.')
  await until(
    async () =>
      (await writer.client.call<Durable>(documentPath() + '/durable')).stateHash ===
      stateHash(open.doc),
    'Amendment durable',
  )
  const amended = await writer.client.call<DocumentRecord>(documentPath())
  assert.notEqual(amended.stateHash, amended.submitted?.stateHash)
  await writer.client.call(
    documentPath() + '/history',
    'POST',
    { action: 'restore', revisionId: saved.id, epoch: amended.epoch, stateHash: amended.stateHash },
    204,
  )
  await until(open.closed, 'Restore disconnects old room')
  open.stop()
  const restored = await writer.client.call<DocumentRecord>(documentPath())
  assert.equal(restored.stateHash, original.stateHash)
  assert.equal(restored.epoch, original.epoch + 1)
  const history = await writer.client.call<Page<{ id: string; label: string }>>(
    documentPath() + '/history',
  )
  assert.ok(history.items.some((item) => item.label === 'Before restore'))
  const rejoined = connect(partner.client, documentId, restored.epoch)
  await until(rejoined.synced, 'Rejoin restored room')
  assert.doesNotMatch(docText(rejoined.doc), /amendment requires/)
  const latest = await writer.client.call<CaseRecord>(route)
  await writer.client.call(route, 'PATCH', { ...update, version: latest.version, memberIds: [] }, 204)
  await until(rejoined.closed, 'Removing access disconnects open editor')
  rejoined.stop()
  await partner.client.call(route, 'GET', undefined, 404)
  privateCase = await writer.client.call<CaseRecord>(route)
  const current = await writer.client.call<DocumentRecord>(documentPath())
  const editing = connect(writer.client, documentId, current.epoch)
  await until(editing.synced, 'Editor before disable')
  await admin.call('/accounts/' + writer.user.id + '/action', 'POST', { action: 'disable' })
  await until(editing.closed, 'Disabling account disconnects open editor')
  editing.stop()
  await writer.client.call(route, 'GET', undefined, 401)
  await admin.call('/accounts/' + writer.user.id + '/action', 'POST', { action: 'enable' })
  await writer.client.call('/auth/login', 'POST', {
    username: writer.user.username,
    password: issuedPassword,
  })
  await writer.client.call(
    route + '/status',
    'POST',
    { version: privateCase.version, action: 'move', status: 'closed' },
    204,
  )
  let record = await writer.client.call<CaseRecord>(route)
  assert.equal(record.writable, false)
  await writer.client.call(route, 'PATCH', { ...update, version: record.version }, 409)
  await writer.client.call(
    route + '/status',
    'POST',
    { version: record.version, action: 'reopen' },
    204,
  )
  record = await writer.client.call<CaseRecord>(route)
  await writer.client.call(
    route + '/status',
    'POST',
    { version: record.version, action: 'archive' },
    204,
  )
  record = await writer.client.call<CaseRecord>(route)
  assert.equal(record.statusId, 'archived')
  assert.deepEqual((await writer.client.call<Page<CaseRecord>>('/search/cases?q=Saffron')).items, [])
  assert.equal(
    (await writer.client.call<Page<CaseRecord>>('/search/cases?q=Saffron&archived=only')).items[0]?.id,
    privateCase.id,
  )
  await writer.client.call(
    route + '/status',
    'POST',
    { version: record.version, action: 'restore' },
    204,
  )
})

test('items, unsafe URL rejection, search by person and tag, and history retention', async () => {
  const route = '/cases/' + publicCase.id
  await admin.call('/admin/tags', 'POST', { label: 'Copper review' }, 204)
  const { tags } = await admin.call<{ tags: { id: string; label: string }[] }>('/catalog')
  const tag = tags.find((item) => item.label === 'Copper review')!
  await writer.client.call(
    route,
    'PATCH',
    { title: publicCase.title, leadId: writer.user.id, tagIds: [tag.id], version: publicCase.version },
    204,
  )
  let record = await writer.client.call<CaseRecord>(route)
  const person = await writer.client.call<{ id: string }>(
    route + '/persons',
    'POST',
    { name: 'Officer Alder', role: 'OFFICER', version: record.version },
    201,
  )
  record = await writer.client.call<CaseRecord>(route)
  const witness = await writer.client.call<{ id: string }>(
    route + '/persons',
    'POST',
    { name: 'Sparrow H.', role: 'WITNESS', version: record.version },
    201,
  )
  record = await writer.client.call<CaseRecord>(route)
  const profile = await writer.client.call<{ id: string }>(
    route + '/persons/' + witness.id + '/profile',
    'POST',
    { version: record.version },
    201,
  )
  const document = await writer.client.call<DocumentRecord>(
    '/documents/case/' + record.id,
    'POST',
    { title: 'Field notebook', type: 'NOTES' },
    201,
  )
  await writer.client.call(
    route + '/evidence',
    'POST',
    { type: 'IMAGE', title: 'Unsafe source', sourceUrl: 'javascript:alert(1)' },
    422,
  )
  await writer.client.call(
    route + '/evidence',
    'POST',
    { type: 'IMAGE', title: 'Unapproved source', sourceUrl: 'https://example.org/image.jpg' },
    422,
  )
  const evidence = await writer.client.call<{ id: string; version: number; reference: number }>(
    route + '/evidence',
    'POST',
    {
      type: 'IMAGE',
      title: 'Fictional depot reference',
      sourceUrl: 'https://i.imgur.com/example.jpg?key=preserved',
      documentId: document.id,
      personId: person.id,
    },
    201,
  )
  await writer.client.call(
    route + '/evidence/' + evidence.id,
    'PATCH',
    {
      type: 'IMAGE',
      title: 'Replacement depot reference',
      sourceUrl: 'https://i.imgur.com/replacement.jpg',
      version: evidence.version,
    },
    204,
  )
  const evidenceHistory = await writer.client.call(route + '/evidence/' + evidence.id + '/history')
  assert.match(JSON.stringify(evidenceHistory), /key=preserved/)
  const task = await writer.client.call<{ id: string; version: number }>(
    route + '/tasks',
    'POST',
    {
      description: 'Verify arrival time',
      assigneeId: writer.user.id,
      documentId: document.id,
      evidenceId: evidence.id,
    },
    201,
  )
  await writer.client.call(
    route + '/tasks/' + task.id,
    'PATCH',
    {
      description: 'Verify arrival time',
      assigneeId: writer.user.id,
      status: 'DONE',
      version: task.version,
    },
    204,
  )
  record = await writer.client.call<CaseRecord>(route)
  assert.equal(record.tasks[0]?.completedBy?.id, writer.user.id)
  assert.equal(record.evidence[0]?.reference, evidence.reference)
  for (const q of ['Copper review', 'Officer Alder', 'Sparrow H.', 'Field notebook']) {
    const results = await writer.client.call<Page<CaseRecord>>(
      '/search/cases?q=' + encodeURIComponent(q),
    )
    assert.ok(
      results.items.some((item) => item.id === publicCase.id),
      q,
    )
  }
  await admin.call('/admin/tags/' + tag.id, 'DELETE', {}, 204)
  assert.equal((await writer.client.call<CaseRecord>(route)).tags.length, 0)
  await writer.client.call(
    '/profiles/' + profile.id + '/archive',
    'POST',
    { archived: true, version: 1 },
    204,
  )
  assert.equal(
    (await writer.client.call<CaseRecord>(route)).persons.find((item) => item.id === witness.id)
      ?.profile?.id,
    profile.id,
  )
  await writer.client.call('/documents/' + record.documents[0]!.id, 'DELETE', { version: 1 }, 409)
})

test('charge catalog permissions, local calendar search, and submitted charge snapshots', async () => {
  const draft = await openCase(writer.client, 'Fictional east district review', {
    occurredAt: '2026-11-12T05:00:00.000Z',
  })
  const route = '/cases/' + draft.id
  const report = draft.documents[0]!
  const catalogInput = {
    code: 'Q-104',
    title: 'Fictional ordinance entry',
    custodyMinutes: 45,
    fineCents: 1545,
  }
  await writer.client.call('/penal-code', 'POST', catalogInput, 403)
  const charge = await admin.call<Charge>('/penal-code', 'POST', catalogInput, 201)
  const edit = {
    ...catalogInput,
    custodyMinutes: 90,
    fineCents: 2550,
    archived: false,
    version: charge.version,
  }
  await writer.client.call('/penal-code/' + charge.id, 'PATCH', edit, 403)
  const search = await viewer.client.call<Page<Charge>>('/penal-code?q=q-104')
  assert.equal(search.items[0]?.id, charge.id)
  const localDay = '/search/cases?q=east%20district&from=2026-11-11&to=2026-11-11'
  const pacific = await writer.client.call<Page<CaseRecord>>(
    localDay + '&timeZone=America%2FLos_Angeles',
  )
  assert.equal(pacific.items[0]?.id, draft.id)
  assert.deepEqual((await writer.client.call<Page<CaseRecord>>(localDay + '&timeZone=UTC')).items, [])

  const person = await writer.client.call<{ id: string }>(
    route + '/persons',
    'POST',
    {
      name: 'Fictional Casey',
      role: 'SUSPECT',
      version: draft.version,
    },
    201,
  )
  const record = await writer.client.call<CaseRecord>(route)
  const assignment = route + '/persons/' + person.id + '/charges'
  const initial = {
    version: record.version,
    charges: [{ chargeId: charge.id, count: 2, fineCents: 0 }],
  }
  await viewer.client.call(assignment, 'PUT', initial, 403)
  await writer.client.call(assignment, 'PUT', initial, 204)
  await writer.client.call(assignment, 'PUT', initial, 409)
  await admin.call('/penal-code/' + charge.id, 'PATCH', edit, 204)
  await admin.call('/penal-code/' + charge.id, 'PATCH', edit, 409)
  let calculated = await writer.client.call<ChargeReport>(route + '/charges')
  assert.equal(calculated.suspects[0]?.fineCents, 3090)
  assert.equal(calculated.suspects[0]?.custodyMinutes, 90)
  const collab = connect(writer.client, report.id, report.epoch)
  await until(collab.synced, 'New case report editor')
  addParagraph(collab.doc, 'The witness provided a dated statement about the incident.')
  await until(
    async () =>
      (await writer.client.call<Durable>('/documents/' + report.id + '/durable')).stateHash ===
      stateHash(collab.doc),
    'Saved narrative',
  )
  const history = '/documents/' + report.id + '/history'
  const submit = { action: 'submit', epoch: report.epoch, stateHash: stateHash(collab.doc) }
  await writer.client.call(history, 'POST', { ...submit, chargeVersion: 0 }, 409)
  await writer.client.call(history, 'POST', { ...submit, chargeVersion: calculated.version }, 204)
  collab.stop()
  const current = await writer.client.call<CaseRecord>(route)
  await writer.client.call(
    assignment,
    'PUT',
    { version: current.version, charges: [{ chargeId: charge.id, count: 3 }] },
    204,
  )
  calculated = await writer.client.call<ChargeReport>(route + '/charges')
  assert.equal(calculated.suspects[0]?.fineCents, 4635)
  const legal = await writer.client.call<DocumentRecord>(
    '/documents/case/' + draft.id,
    'POST',
    { title: 'Fictional records request', type: 'SUBPOENA' },
    201,
  )
  const stored = await db.document.findUniqueOrThrow({ where: { id: legal.id } })
  assert.match(stored.plainText, /Issuing authority and approval/)
  const packetBody = { documents: [report.id, legal.id], evidence: false, tasks: false }
  const packet = await writer.client.call<Packet>(route + '/export', 'POST', packetBody)
  assert.equal(packet.charges[0]?.fineCents, 4635)
  assert.equal(packet.submittedCharges?.[0]?.fineCents, 3090)
  assert.equal(packet.documents.find((doc) => doc.id === report.id)?.amended, true)
  assert.equal(packet.documents.find((doc) => doc.id === legal.id)?.legalDraft, true)
  const excluded = await writer.client.call<Packet>(route + '/export', 'POST', {
    ...packetBody,
    charges: false,
  })
  assert.deepEqual(excluded.charges, [])
  assert.equal(excluded.submittedCharges, null)
  assert.ok(!JSON.stringify(excluded.case.persons).includes('fineCents'))
  const latest = await writer.client.call<CaseRecord>(route)
  await writer.client.call(
    route + '/status',
    'POST',
    { action: 'move', status: 'active', version: latest.version },
    409,
  )
})

test('account security, deletion restrictions and retained historical attribution', async () => {
  const member = await provision(admin, 'INVESTIGATOR', 'Fictional Archive Member')
  const additional = new Client(origin)
  await additional.call('/auth/login', 'POST', {
    username: member.user.username,
    password: issuedPassword,
  })
  const record = await openCase(member.client, 'Fictional cleanup test case', {
    leadId: member.user.id,
    memberIds: [member.user.id],
  })
  const route = '/cases/' + record.id
  const document = record.documents[0]!
  const evidence = await member.client.call<{ id: string }>(
    route + '/evidence',
    'POST',
    { title: 'Fictional item', type: 'NOTE' },
    201,
  )
  await member.client.call(
    route + '/evidence/' + evidence.id + '/notes',
    'POST',
    { note: 'Fictional note' },
    201,
  )
  await member.client.call(
    route + '/tasks',
    'POST',
    {
      description: 'Test linked references',
      evidenceId: evidence.id,
      documentId: document.id,
      status: 'DONE',
    },
    201,
  )
  const profile = await member.client.call<ProfileRecord>(
    '/profiles',
    'POST',
    { fullName: 'Fictional cleanup profile' },
    201,
  )
  await member.client.call(
    route + '/persons',
    'POST',
    { name: 'Name as recorded', role: 'WITNESS', profileId: profile.id, version: record.version },
    201,
  )

  assert.equal((await member.client.call<{ otherSessions: number }>('/auth/sessions')).otherSessions, 1)
  await member.client.call('/auth/sessions', 'DELETE', undefined, 204)
  await additional.call('/auth/session', 'GET', undefined, 401)
  const changedPassword = 'Replacement test password ' + randomBytes(8).toString('hex')
  await member.client.call(
    '/auth/password',
    'POST',
    { current: 'incorrect password', password: changedPassword },
    422,
  )
  await member.client.call(
    '/auth/password',
    'POST',
    { current: issuedPassword, password: changedPassword },
    204,
  )
  await member.client.call('/auth/session', 'GET', undefined, 401)
  await member.client.call('/auth/login', 'POST', {
    username: member.user.username,
    password: changedPassword,
  })

  const accountPath = '/accounts/' + member.user.id
  const listed = await admin.call<Page<Account>>('/accounts?q=' + member.user.username)
  const user = listed.items.find((item) => item.id === member.user.id)!
  const renamed = member.user.username + '-new'
  const newAccount = {
    username: renamed,
    displayName: 'Fictional Renamed Member',
    badge: 'TEST-1',
    role: 'INVESTIGATOR',
    version: user.version,
  }
  await writer.client.call(accountPath, 'PATCH', newAccount, 403)
  await admin.call(accountPath, 'PATCH', newAccount, 204)
  await admin.call(accountPath, 'PATCH', newAccount, 409)
  await member.client.call('/auth/session', 'GET', undefined, 401)
  await member.client.call('/auth/login', 'POST', { username: renamed, password: changedPassword })
  const live = connect(member.client, document.id, document.epoch)
  await until(live.synced, 'Account deletion editor')
  await admin.call(accountPath, 'DELETE', { version: user.version + 1, confirmation: 'wrong' }, 422)
  await admin.call(accountPath, 'DELETE', { version: user.version + 1, confirmation: renamed }, 204)
  await until(live.closed, 'Deleting account disconnects editor')
  live.stop()
  await member.client.call('/auth/session', 'GET', undefined, 401)
  let remaining = await admin.call<CaseRecord>(route)
  assert.equal(remaining.documents[0]?.author, null)
  assert.equal(remaining.documents[0]?.authorName, 'Fictional Archive Member')
  assert.equal(remaining.evidence[0]?.submittedByName, 'Fictional Archive Member')
  assert.equal(remaining.tasks[0]?.completedByName, 'Fictional Archive Member')
  assert.equal(remaining.lead, null)
  assert.deepEqual(remaining.members, [])

  const profilePath = '/profiles/' + profile.id
  await writer.client.call(
    profilePath,
    'DELETE',
    { confirmation: 'DELETE', version: profile.version },
    403,
  )
  await admin.call(profilePath, 'DELETE', { confirmation: 'DELETE', version: profile.version }, 204)
  await admin.call(profilePath, 'GET', undefined, 404)
  remaining = await admin.call<CaseRecord>(route)
  assert.equal(remaining.persons[0]?.name, 'Name as recorded')
  assert.equal(remaining.persons[0]?.profileId, null)

  const adminSocket = connect(admin, document.id, document.epoch)
  await until(adminSocket.synced, 'Open editor before case deletion')
  await writer.client.call(
    route,
    'DELETE',
    { confirmation: record.number, version: remaining.version },
    403,
  )
  await admin.call(route, 'DELETE', { confirmation: record.number, version: remaining.version }, 204)
  await until(adminSocket.closed, 'Case deletion disconnects editor')
  adminSocket.stop()
  await admin.call(route, 'GET', undefined, 404)
  await admin.call('/documents/' + document.id, 'GET', undefined, 404)
  assert.equal(await db.custodyNote.count({ where: { evidenceId: evidence.id } }), 0)
  assert.equal(await db.audit.count({ where: { caseId: record.id, action: 'case.deleted' } }), 1)
})

test(
  'native PostgreSQL dump restores case metadata and canonical Yjs bytes into a fresh database',
  {
    skip:
      !process.env.TEST_PG_BIN && 'Set TEST_PG_BIN to a directory containing pg_dump and pg_restore.',
  },
  async () => {
    const name = 'crash_mdt_test_restore' + randomBytes(4).toString('hex')
    const path = await mkdtemp(join(tmpdir(), 'crash-restore-'))
    const source = testDatabase()
    const destination = new URL(source)
    destination.pathname = '/' + name
    const bin = process.env.TEST_PG_BIN!
    const exe = (name: string) => join(bin, name + (process.platform === 'win32' ? '.exe' : ''))
    const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(new URL(source).password) }
    const connectionArg = (url: URL) => {
      const safe = new URL(url)
      safe.password = ''
      return safe.toString()
    }
    const { PrismaClient } = await import('../generated/prisma/client.js')
    const { PrismaPg } = await import('@prisma/adapter-pg')
    const restored = new PrismaClient({
      adapter: new PrismaPg({ connectionString: destination.toString() }),
    })
    try {
      await db.$executeRawUnsafe('CREATE DATABASE "' + name + '"')
      const archive = join(path, 'backup.dump')
      await exec(
        exe('pg_dump'),
        [
          '--format=custom',
          '--no-owner',
          '--no-privileges',
          '--file',
          archive,
          connectionArg(new URL(source)),
        ],
        { env: pgEnv },
      )
      await exec(
        exe('pg_restore'),
        [
          '--single-transaction',
          '--exit-on-error',
          '--no-owner',
          '--no-privileges',
          '--dbname',
          connectionArg(destination),
          archive,
        ],
        { env: pgEnv },
      )
      const before = await db.document.findUniqueOrThrow({ where: { id: documentId } })
      const after = await restored.document.findUniqueOrThrow({
        where: { id: documentId },
        include: { case: true },
      })
      assert.equal(after.case.number, privateCase.number)
      assert.deepEqual(after.state, before.state)
      const doc = new Y.Doc()
      Y.applyUpdate(doc, after.state)
      assert.match(docText(doc), /blue van/)
      doc.destroy()
    } finally {
      await restored.$disconnect()
      await db.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)')
      await rm(path, { recursive: true, force: true })
    }
  },
)

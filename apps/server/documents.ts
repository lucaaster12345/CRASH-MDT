import { Router } from 'express'
import { z } from 'zod'
import {
  documentTypes,
  id,
  meaningfulNarrative,
  requiredText,
  text,
  version,
} from '../../packages/shared/validation.js'
import { actor } from './auth.js'
import { audit, db, publicUser, type Actor, type Database } from './db.js'
import { check, checkVersion } from './errors.js'
import { isCaseEditor, visibleCase, withCase } from './access.js'
import { documentMeta } from './cases.js'
import { decodeDocument, initialDocument } from './document-state.js'
import { publish } from './live.js'
import { checkNoPending, roomName, storageFailed } from './collaboration.js'

async function findDocument(user: Actor, documentId: string) {
  const doc = await db.document.findFirst({
    where: { id: documentId, removedAt: null, case: visibleCase(user) },
    select: {
      ...documentMeta,
      narrativeText: true,
      case: { select: { id: true, number: true, title: true, statusId: true } },
    },
  })
  check(doc, 404, 'Document not found or access has changed.')
  return doc
}

async function target(tx: Database, caseId: string, id: string) {
  const doc = await tx.document.findFirst({ where: { id, caseId, removedAt: null } })
  check(doc, 404, 'Document not found or access has changed.')
  return doc
}

const metadata = z.object({ title: requiredText(180), category: text(100).default('') })
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const epoch = z.number().int().positive()
export const documents = Router()

documents.post('/case/:caseId', async (req, res) => {
  const caseId = id.parse(req.params.caseId)
  const input = metadata
    .extend({ type: z.enum(documentTypes).exclude(['INCIDENT']), template: z.boolean().default(true) })
    .parse(req.body)
  const doc = await withCase(req, caseId, async (tx, user) => {
    const { template, ...fields } = input
    const headings = template
      ? ((await tx.template.findUnique({ where: { type: input.type } }))?.headings ?? [])
      : []
    const document = await tx.document.create({
      data: { ...fields, caseId, authorId: user.id, ...initialDocument(headings) },
      select: documentMeta,
    })
    await audit(
      tx,
      user.id,
      'document.created',
      'document',
      document.id,
      { title: document.title, type: document.type },
      caseId,
    )
    return document
  })
  publish({ caseId })
  res.status(201).json(doc)
})

documents.get('/:id', async (req, res) => {
  const { narrativeText, ...doc } = await findDocument(actor(req), id.parse(req.params.id))
  res.json({
    ...doc,
    writable: isCaseEditor(actor(req), doc.case.statusId),
    meaningful: meaningfulNarrative(narrativeText),
  })
})

documents.get('/:id/durable', async (req, res) => {
  const documentId = id.parse(req.params.id)
  const doc = await db.document.findFirst({
    where: { id: documentId, removedAt: null, case: visibleCase(actor(req)) },
    select: { epoch: true, stateHash: true },
  })
  check(doc, 404, 'Document not found or access has changed.')
  res.json({ ...doc, failed: storageFailed(roomName(documentId, doc.epoch)) })
})

documents.patch('/:id', async (req, res) => {
  const { id: documentId, caseId } = await findDocument(actor(req), id.parse(req.params.id))
  const { version: expected, ...data } = metadata.extend({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user) => {
    const before = await target(tx, caseId, documentId)
    check(before.type !== 'INCIDENT', 409, 'The main incident report title is fixed.')
    checkVersion(before.version, expected)
    await tx.document.update({
      where: { id: documentId },
      data: { ...data, version: { increment: 1 } },
    })
    await audit(
      tx,
      user.id,
      'document.updated',
      'document',
      documentId,
      { before: { title: before.title, category: before.category }, after: data },
      caseId,
    )
  })
  publish({ caseId })
  res.sendStatus(204)
})

documents.delete('/:id', async (req, res) => {
  const { id: documentId, caseId } = await findDocument(actor(req), id.parse(req.params.id))
  const input = z.object({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user) => {
    const before = await target(tx, caseId, documentId)
    check(before.type !== 'INCIDENT', 409, 'The main incident report is required.')
    checkVersion(before.version, input.version)
    check(
      checkNoPending(roomName(documentId, before.epoch), before.stateHash),
      409,
      'Wait for all document edits to save.',
    )
    await tx.document.update({
      where: { id: documentId },
      data: { removedAt: new Date(), epoch: { increment: 1 }, version: { increment: 1 } },
    })
    await audit(
      tx,
      user.id,
      'document.removed',
      'document',
      documentId,
      { title: before.title },
      caseId,
    )
  })
  publish({ caseId, documentId, disconnect: true })
  res.sendStatus(204)
})

documents.get('/:id/history', async (req, res) => {
  const document = await findDocument(actor(req), id.parse(req.params.id))
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(req.query.page ?? 1)
  const items = await db.revision.findMany({
    where: { documentId: document.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * 30,
    take: 31,
    select: { id: true, label: true, kind: true, createdAt: true, actor: { select: publicUser } },
  })
  res.json({ items: items.slice(0, 30), more: items.length > 30 })
})

documents.get('/:id/history/:revisionId', async (req, res) => {
  const doc = await findDocument(actor(req), id.parse(req.params.id))
  const revision = await db.revision.findFirst({
    where: { id: id.parse(req.params.revisionId), documentId: doc.id },
  })
  check(revision, 404, 'Revision not found.')
  const { state, narrativeText: _narrative, ...meta } = revision
  res.json({ ...meta, content: decodeDocument(state) })
})

documents.post('/:id/history', async (req, res) => {
  const { id: documentId, caseId } = await findDocument(actor(req), id.parse(req.params.id))
  const input = z
    .discriminatedUnion('action', [
      z.object({ action: z.literal('checkpoint'), label: requiredText(120), stateHash: hash, epoch }),
      z.object({ action: z.literal('submit'), stateHash: hash, epoch }),
      z.object({ action: z.literal('restore'), revisionId: id, stateHash: hash, epoch }),
    ])
    .parse(req.body)
  await withCase(req, caseId, async (tx, user) => {
    const current = await target(tx, caseId, documentId)
    check(
      current.epoch === input.epoch &&
        current.stateHash === input.stateHash &&
        checkNoPending(roomName(documentId, current.epoch), current.stateHash),
      409,
      'Wait for the latest document edits to save and try again.',
    )
    const { state, stateHash, plainText, narrativeText } = current
    const content = { state, stateHash, plainText, narrativeText }
    if (input.action === 'submit') {
      check(
        current.type === 'INCIDENT' && meaningfulNarrative(narrativeText),
        422,
        'Add a meaningful incident narrative before submitting.',
      )
    }
    const saved = await tx.revision.create({
      data: {
        documentId,
        actorId: user.id,
        ...content,
        label:
          input.action === 'checkpoint'
            ? input.label
            : input.action === 'submit'
              ? 'Submitted report'
              : 'Before restore',
        kind:
          input.action === 'checkpoint'
            ? 'MANUAL'
            : input.action === 'submit'
              ? 'SUBMITTED'
              : 'BEFORE_RESTORE',
      },
    })
    if (input.action === 'submit')
      await tx.document.update({ where: { id: documentId }, data: { submittedId: saved.id } })
    if (input.action === 'restore') {
      const revision = await tx.revision.findFirst({ where: { id: input.revisionId, documentId } })
      check(revision, 404, 'Revision not found.')
      await tx.document.update({
        where: { id: documentId },
        data: {
          state: revision.state,
          stateHash: revision.stateHash,
          plainText: revision.plainText,
          narrativeText: revision.narrativeText,
          epoch: { increment: 1 },
          version: { increment: 1 },
        },
      })
    }
    await tx.case.update({ where: { id: caseId }, data: { updatedAt: new Date() } })
    await audit(
      tx,
      user.id,
      'document.' + input.action,
      'document',
      documentId,
      { saved: saved.id, ...(input.action === 'restore' ? { restored: input.revisionId } : {}) },
      caseId,
    )
  })
  publish({ caseId, documentId, disconnect: input.action === 'restore' })
  res.sendStatus(204)
})

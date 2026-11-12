import { Router } from 'express'
import { z } from 'zod'
import {
  evidenceTypes,
  https,
  id,
  imageAllowed,
  isoTime,
  nullableId,
  priority,
  requiredText,
  taskStatuses,
  text,
  version,
} from '../../packages/shared/validation.js'
import { audit, auditValues, db, type Actor, type Database } from './db.js'
import { check, checkVersion } from './errors.js'
import { withCase } from './access.js'
import { imageHosts } from './settings.js'
import { publish } from './live.js'

export const caseItems = Router({ mergeParams: true })

async function changed(
  tx: Database,
  actor: Actor,
  caseId: string,
  action: string,
  target: string,
  targetId: string,
  details: unknown,
) {
  await tx.case.update({ where: { id: caseId }, data: { updatedAt: new Date() } })
  await audit(tx, actor.id, action, target, targetId, auditValues(details), caseId)
}

const evidenceInput = z.object({
  title: requiredText(180),
  type: z.enum(evidenceTypes),
  description: text(6000).default(''),
  sourceUrl: https.nullable().default(null),
  collectedAt: isoTime,
  personId: nullableId,
  documentId: nullableId,
})

async function validateEvidence(
  tx: Database,
  caseId: string,
  input: z.infer<typeof evidenceInput>,
  previous?: string | null,
) {
  check(input.sourceUrl || input.type === 'NOTE', 422, 'Enter a source URL for images and links.')
  if (input.sourceUrl && input.type === 'IMAGE' && input.sourceUrl !== previous) {
    check(
      imageAllowed(input.sourceUrl, await imageHosts(tx)),
      422,
      'Choose an image URL from an approved host.',
    )
  }
  if (input.personId)
    check(
      await tx.casePerson.findFirst({ where: { id: input.personId, caseId } }),
      422,
      'Choose a person on this case.',
    )
  await checkDocument(tx, caseId, input.documentId)
}

async function checkDocument(tx: Database, caseId: string, documentId: string | null) {
  if (documentId)
    check(
      await tx.document.findFirst({
        where: { id: documentId, caseId, removedAt: null },
        select: { id: true },
      }),
      422,
      'Choose a document on this case.',
    )
}

caseItems.post('/evidence', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const input = evidenceInput.parse(req.body)
  const item = await withCase(req, caseId, async (tx, user, record) => {
    await validateEvidence(tx, caseId, input)
    const evidence = await tx.evidence.create({
      data: { ...input, caseId, reference: record.nextEvidence, submittedById: user.id },
    })
    await tx.case.update({ where: { id: caseId }, data: { nextEvidence: { increment: 1 } } })
    await changed(tx, user, caseId, 'evidence.added', 'evidence', evidence.id, { after: evidence })
    return evidence
  })
  publish({ caseId })
  res.status(201).json(item)
})

caseItems.patch('/evidence/:itemId', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const itemId = id.parse(req.params.itemId)
  const { version: expected, ...input } = evidenceInput.extend({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user) => {
    const before = await tx.evidence.findFirst({ where: { id: itemId, caseId, removedAt: null } })
    check(before, 404, 'Evidence not found.')
    checkVersion(before.version, expected)
    await validateEvidence(tx, caseId, input, before.type === input.type ? before.sourceUrl : null)
    const after = await tx.evidence.update({
      where: { id: itemId },
      data: { ...input, version: { increment: 1 } },
    })
    await changed(tx, user, caseId, 'evidence.updated', 'evidence', itemId, { before, after })
  })
  publish({ caseId })
  res.sendStatus(204)
})

caseItems.delete('/evidence/:itemId', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const itemId = id.parse(req.params.itemId)
  const { version: expected } = z.object({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user) => {
    const before = await tx.evidence.findFirst({ where: { id: itemId, caseId, removedAt: null } })
    check(before, 404, 'Evidence not found.')
    checkVersion(before.version, expected)
    await tx.evidence.update({
      where: { id: itemId },
      data: { removedAt: new Date(), version: { increment: 1 } },
    })
    await changed(tx, user, caseId, 'evidence.removed', 'evidence', itemId, { before })
  })
  publish({ caseId })
  res.sendStatus(204)
})

caseItems.post('/evidence/:itemId/notes', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const evidenceId = id.parse(req.params.itemId)
  const { note } = z.object({ note: requiredText(3000) }).parse(req.body)
  const item = await withCase(req, caseId, async (tx, user) => {
    check(
      await tx.evidence.findFirst({ where: { id: evidenceId, caseId, removedAt: null } }),
      404,
      'Evidence not found.',
    )
    const saved = await tx.custodyNote.create({ data: { evidenceId, text: note, actorId: user.id } })
    await changed(tx, user, caseId, 'evidence.custody_note', 'evidence', evidenceId, {
      noteId: saved.id,
    })
    return saved
  })
  publish({ caseId })
  res.status(201).json(item)
})

caseItems.get('/evidence/:itemId/history', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const evidenceId = id.parse(req.params.itemId)
  const { scopedCase } = await import('./access.js')
  await scopedCase(db, req.identity!.user, caseId)
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(req.query.page ?? 1)
  const rows = await db.audit.findMany({
    where: { caseId, target: 'evidence', targetId: evidenceId },
    select: {
      id: true,
      action: true,
      details: true,
      createdAt: true,
      actor: { select: { displayName: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * 30,
    take: 31,
  })
  res.json({ items: rows.slice(0, 30), more: rows.length > 30 })
})

const taskInput = z.object({
  description: requiredText(1800),
  assigneeId: nullableId,
  dueAt: isoTime,
  priority: priority.default('NORMAL'),
  status: z.enum(taskStatuses).default('TODO'),
  documentId: nullableId,
  evidenceId: nullableId,
})

async function validateTask(
  tx: Database,
  caseId: string,
  input: z.infer<typeof taskInput>,
  previousAssignee?: string | null,
) {
  if (input.assigneeId && input.assigneeId !== previousAssignee) {
    const user = await tx.user.findFirst({
      where: { id: input.assigneeId, disabledAt: null },
      select: { id: true, role: true },
    })
    check(user, 422, 'Choose an active assignee.')
    const visible = await tx.case.findFirst({
      where: {
        id: caseId,
        ...(user.role === 'ADMIN'
          ? {}
          : {
              OR: [
                { restricted: false },
                { leadId: user.id },
                { members: { some: { userId: user.id } } },
              ],
            }),
      },
    })
    check(visible, 422, 'Assign this restricted case to the officer first.')
  }
  await checkDocument(tx, caseId, input.documentId)
  if (input.evidenceId)
    check(
      await tx.evidence.findFirst({ where: { id: input.evidenceId, caseId, removedAt: null } }),
      422,
      'Choose evidence on this case.',
    )
}

caseItems.post('/tasks', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const input = taskInput.parse(req.body)
  const task = await withCase(req, caseId, async (tx, user) => {
    await validateTask(tx, caseId, input)
    const result = await tx.task.create({
      data: {
        ...input,
        caseId,
        completedAt: input.status === 'DONE' ? new Date() : null,
        completedById: input.status === 'DONE' ? user.id : null,
      },
    })
    await changed(tx, user, caseId, 'task.created', 'task', result.id, { after: result })
    return result
  })
  publish({ caseId })
  res.status(201).json(task)
})

caseItems.patch('/tasks/:itemId', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const itemId = id.parse(req.params.itemId)
  const { version: expected, ...input } = taskInput.extend({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user) => {
    const before = await tx.task.findFirst({ where: { id: itemId, caseId } })
    check(before, 404, 'Task not found.')
    checkVersion(before.version, expected)
    await validateTask(tx, caseId, input, before.assigneeId)
    const completed = input.status === 'DONE' && before.status !== 'DONE'
    const reopened = input.status !== 'DONE' && before.status === 'DONE'
    const after = await tx.task.update({
      where: { id: itemId },
      data: {
        ...input,
        version: { increment: 1 },
        ...(completed
          ? { completedAt: new Date(), completedById: user.id }
          : reopened
            ? { completedAt: null, completedById: null }
            : {}),
      },
    })
    await changed(
      tx,
      user,
      caseId,
      completed ? 'task.completed' : reopened ? 'task.reopened' : 'task.updated',
      'task',
      itemId,
      { before, after },
    )
  })
  publish({ caseId })
  res.sendStatus(204)
})

caseItems.delete('/tasks/:itemId', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const itemId = id.parse(req.params.itemId)
  const { version: expected } = z.object({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user) => {
    const before = await tx.task.findFirst({ where: { id: itemId, caseId } })
    check(before, 404, 'Task not found.')
    checkVersion(before.version, expected)
    await tx.task.delete({ where: { id: itemId } })
    await changed(tx, user, caseId, 'task.removed', 'task', itemId, { before })
  })
  publish({ caseId })
  res.sendStatus(204)
})

caseItems.post('/external-links', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const input = z
    .object({ title: requiredText(180), description: text(1500).default(''), url: https, version })
    .parse(req.body)
  await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, input.version)
    const { version: _expected, ...data } = input
    const link = await tx.externalLink.create({ data: { caseId, ...data } })
    await tx.case.update({ where: { id: caseId }, data: { version: { increment: 1 } } })
    await changed(tx, user, caseId, 'case.external_link_added', 'link', link.id, { after: link })
  })
  publish({ caseId })
  res.sendStatus(204)
})

caseItems.delete('/external-links/:itemId', async (req, res) => {
  const caseId = id.parse((req.params as Record<string, string>).id)
  const itemId = id.parse(req.params.itemId)
  const { version: expected } = z.object({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, expected)
    const before = await tx.externalLink.findFirst({ where: { id: itemId, caseId } })
    check(before, 404, 'External document link not found.')
    await tx.externalLink.delete({ where: { id: itemId } })
    await tx.case.update({ where: { id: caseId }, data: { version: { increment: 1 } } })
    await changed(tx, user, caseId, 'case.external_link_removed', 'link', itemId, { before })
  })
  publish({ caseId })
  res.sendStatus(204)
})

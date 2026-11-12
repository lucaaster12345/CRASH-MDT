import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  id,
  ids,
  isoTime,
  meaningfulNarrative,
  nullableId,
  personRoles,
  priority,
  requiredText,
  statusKey,
  text,
  version,
} from '../../packages/shared/validation.js'
import type { Prisma } from '../../generated/prisma/client.js'
import { actor, lockIdentity, requireEditor } from './auth.js'
import { db, audit, auditValues, publicUser, type Database, type Actor } from './db.js'
import { check, checkVersion } from './errors.js'
import { isCaseEditor, scopedCase, visibleCase, withCase } from './access.js'
import { initialDocument } from './document-state.js'
import { publish } from './live.js'
import { checkNoPending, roomName } from './collaboration.js'

export const caseCard = {
  id: true,
  number: true,
  title: true,
  summary: true,
  priority: true,
  restricted: true,
  status: true,
  openedAt: true,
  occurredAt: true,
  updatedAt: true,
  lead: { select: publicUser },
  tags: { include: { tag: true } },
} satisfies Prisma.CaseSelect

export const documentMeta = {
  id: true,
  caseId: true,
  title: true,
  type: true,
  category: true,
  epoch: true,
  version: true,
  author: { select: publicUser },
  createdAt: true,
  updatedAt: true,
  stateHash: true,
  submitted: { select: { id: true, stateHash: true, createdAt: true, actor: { select: publicUser } } },
} satisfies Prisma.DocumentSelect

export const evidenceFields = {
  submittedBy: { select: publicUser },
  notes: { orderBy: { createdAt: 'desc' as const }, take: 50 },
} satisfies Prisma.EvidenceInclude

export const taskFields = {
  assignee: { select: publicUser },
  completedBy: { select: publicUser },
} satisfies Prisma.TaskInclude

export async function getCase(tx: Database, user: Actor, caseId: string) {
  const visibility = visibleCase(user)
  const record = await tx.case.findFirst({
    where: { id: caseId, ...visibility },
    include: {
      status: true,
      lead: { select: publicUser },
      members: { include: { user: { select: publicUser } } },
      tags: { include: { tag: true } },
      persons: {
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
        include: {
          profile: { select: { id: true, fullName: true, archivedAt: true } },
          user: { select: publicUser },
        },
      },
      documents: {
        where: { removedAt: null },
        select: documentMeta,
        orderBy: [{ type: 'asc' }, { title: 'asc' }],
      },
      evidence: { where: { removedAt: null }, include: evidenceFields, orderBy: { reference: 'asc' } },
      tasks: {
        include: taskFields,
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
      },
      links: {
        where: { to: visibility },
        select: { explanation: true, to: { select: { id: true, number: true, title: true } } },
      },
      externalLinks: { orderBy: { title: 'asc' } },
      favorites: { where: { userId: user.id }, select: { userId: true } },
    },
  })
  check(record, 404, 'Case not found or access has changed.')
  return { ...record, writable: isCaseEditor(user, record.statusId) }
}

const caseInput = z.object({
  title: requiredText(180),
  summary: text(12000).default(''),
  priority: priority.default('NORMAL'),
  restricted: z.boolean().default(false),
  leadId: nullableId,
  memberIds: ids,
  tagIds: ids,
  occurredAt: isoTime,
})
type CaseInput = z.infer<typeof caseInput>

async function validateAssignments(tx: Database, input: CaseInput, existing: string[] = []) {
  const assigned = [
    ...new Set([input.leadId, ...input.memberIds].filter((item): item is string => !!item)),
  ]
  const active = await tx.user.count({
    where: { id: { in: assigned.filter((item) => !existing.includes(item)) }, disabledAt: null },
  })
  check(
    active === assigned.filter((item) => !existing.includes(item)).length,
    422,
    'Select active officer accounts.',
  )
  const tags = await tx.tag.count({ where: { id: { in: input.tagIds } } })
  check(tags === input.tagIds.length, 422, 'A selected tag is no longer available.')
}

function caseData({ title, summary, priority, restricted, leadId, occurredAt }: CaseInput) {
  return { title, summary, priority, restricted, leadId, occurredAt }
}

export const cases = Router()

cases.post('/', async (req, res) => {
  const input = caseInput.extend({ template: z.boolean().default(true) }).parse(req.body)
  const newCase = await db.$transaction(async (tx) => {
    const user = await lockIdentity(tx, req.identity!)
    requireEditor(user)
    if (input.restricted && !input.leadId) input.leadId = user.id
    if (
      input.restricted &&
      user.role !== 'ADMIN' &&
      input.leadId !== user.id &&
      !input.memberIds.includes(user.id)
    ) {
      input.memberIds.push(user.id)
    }
    await validateAssignments(tx, input)
    const rows = await tx.$queryRaw<
      { n: number }[]
    >`SELECT nextval(pg_get_serial_sequence('"Case"', 'sequence'))::int AS n`
    const sequence = rows[0]!.n
    const number = 'CR-' + new Date().getUTCFullYear() + '-' + String(sequence).padStart(6, '0')
    const template = await tx.template.findUnique({ where: { type: 'INCIDENT' } })
    const record = await tx.case.create({
      data: {
        ...caseData(input),
        number,
        sequence,
        members: { create: input.memberIds.map((userId) => ({ userId })) },
        tags: { create: input.tagIds.map((tagId) => ({ tagId })) },
        documents: {
          create: {
            title: 'Main incident report',
            type: 'INCIDENT',
            author: { connect: { id: user.id } },
            ...initialDocument(input.template ? (template?.headings ?? []) : []),
          },
        },
      },
    })
    await audit(tx, user.id, 'case.created', 'case', record.id, { number }, record.id)
    return { id: record.id, number }
  })
  publish({ caseId: newCase.id })
  res.status(201).json(newCase)
})

cases.get('/:id', async (req, res) => res.json(await getCase(db, actor(req), id.parse(req.params.id))))

cases.patch('/:id', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const input = caseInput.extend({ version }).parse(req.body)
  const revoke = await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, input.version)
    const beforeMembers = await tx.caseMember.findMany({ where: { caseId }, select: { userId: true } })
    const oldIds = beforeMembers.map((row) => row.userId)
    const beforeTags = await tx.caseTag.findMany({ where: { caseId }, select: { tagId: true } })
    await validateAssignments(tx, input, [...oldIds, ...(record.leadId ? [record.leadId] : [])])
    check(
      !input.restricted ||
        user.role === 'ADMIN' ||
        input.leadId === user.id ||
        input.memberIds.includes(user.id),
      422,
      'Keep yourself assigned to the restricted case.',
    )
    await tx.case.update({
      where: { id: caseId },
      data: { ...caseData(input), version: { increment: 1 } },
    })
    await tx.caseMember.deleteMany({ where: { caseId } })
    await tx.caseTag.deleteMany({ where: { caseId } })
    await tx.caseMember.createMany({ data: input.memberIds.map((userId) => ({ userId, caseId })) })
    await tx.caseTag.createMany({ data: input.tagIds.map((tagId) => ({ tagId, caseId })) })
    const accessChanged =
      record.restricted !== input.restricted ||
      (input.restricted &&
        (record.leadId !== input.leadId ||
          oldIds.length !== input.memberIds.length ||
          oldIds.some((item) => !input.memberIds.includes(item))))
    if (accessChanged) {
      await ensureSaved(tx, caseId)
      await tx.document.updateMany({ where: { caseId }, data: { epoch: { increment: 1 } } })
    }
    await audit(
      tx,
      user.id,
      'case.updated',
      'case',
      caseId,
      auditValues({
        before: {
          ...caseData({ ...input, ...record, occurredAt: record.occurredAt?.toISOString() ?? null }),
          memberIds: oldIds,
          tagIds: beforeTags.map((row) => row.tagId),
        },
        after: { ...caseData(input), memberIds: input.memberIds, tagIds: input.tagIds },
      }),
      caseId,
    )
    return accessChanged
  })
  publish({ caseId, disconnect: revoke })
  res.sendStatus(204)
})

cases.post('/:id/status', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const input = z
    .object({
      version,
      action: z.enum(['move', 'reopen', 'archive', 'restore']),
      status: statusKey.optional(),
    })
    .parse(req.body)
  const resetRoom = await withCase(
    req,
    caseId,
    async (tx, user, record) => {
      checkVersion(record.version, input.version)
      let destination: string
      if (input.action === 'archive') {
        check(record.statusId !== 'archived', 409, 'This case is already archived.')
        destination = 'archived'
      } else if (input.action === 'restore') {
        check(record.statusId === 'archived', 409, 'Only archived cases can be restored.')
        destination = record.preArchiveStatus || 'closed'
      } else if (input.action === 'reopen') {
        check(record.statusId === 'closed', 409, 'Only closed cases can be reopened.')
        destination = 'active'
      } else {
        check(
          record.statusId !== 'archived' && record.statusId !== 'closed',
          409,
          'Use Reopen or Restore first.',
        )
        check(input.status && input.status !== 'archived', 422, 'Choose a valid case status.')
        destination = input.status
      }
      check(
        await tx.caseStatus.findUnique({ where: { id: destination } }),
        422,
        'That status is no longer available.',
      )
      if (
        destination !== 'draft' &&
        (record.statusId === 'draft' || (destination === 'closed' && input.action === 'move'))
      ) {
        const report = await tx.document.findFirst({
          where: { caseId, type: 'INCIDENT' },
          include: { submitted: true },
        })
        check(
          report?.submitted &&
            meaningfulNarrative(report.submitted.narrativeText) &&
            report.stateHash === report.submitted.stateHash,
          409,
          'Save and submit the current incident report before changing this status.',
        )
      }
      await tx.case.update({
        where: { id: caseId },
        data: {
          statusId: destination,
          version: { increment: 1 },
          closedAt:
            destination === 'closed'
              ? (record.closedAt ?? new Date())
              : destination === 'archived'
                ? record.closedAt
                : null,
          archivedAt: destination === 'archived' ? new Date() : null,
          preArchiveStatus: destination === 'archived' ? record.statusId : null,
        },
      })
      const freeze =
        ['closed', 'archived'].includes(record.statusId) || ['closed', 'archived'].includes(destination)
      if (freeze) {
        await ensureSaved(tx, caseId)
        await tx.document.updateMany({ where: { caseId }, data: { epoch: { increment: 1 } } })
      }
      await audit(
        tx,
        user.id,
        'case.' + input.action,
        'case',
        caseId,
        { before: record.statusId, after: destination },
        caseId,
      )
      return freeze
    },
    true,
  )
  publish({ caseId, disconnect: resetRoom })
  res.sendStatus(204)
})

async function ensureSaved(tx: Database, caseId: string) {
  const docs = await tx.document.findMany({
    where: { caseId, removedAt: null },
    select: { id: true, epoch: true, stateHash: true },
  })
  check(
    docs.every((doc) => checkNoPending(roomName(doc.id, doc.epoch), doc.stateHash)),
    409,
    'Wait for open documents to save before changing case access or lifecycle status.',
  )
}

const personInput = z.object({
  name: requiredText(180),
  role: z.enum(personRoles),
  detail: text(4000).default(''),
  profileId: nullableId,
  userId: nullableId,
  version,
})

cases.post('/:id/persons', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const { version: expected, ...input } = personInput.parse(req.body)
  const person = await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, expected)
    const data = { ...input, caseId, id: randomUUID() }
    await validatePerson(tx, data)
    await tx.casePerson.create({ data })
    await personChanged(tx, caseId, user, data.id, 'person.added', { after: data })
    return data
  })
  publish({ caseId })
  res.status(201).json(person)
})

async function validatePerson(tx: Database, input: Omit<z.infer<typeof personInput>, 'version'>) {
  check(!input.userId || input.role === 'OFFICER', 422, 'Only an involved officer can link an account.')
  check(
    !input.profileId || input.role !== 'OFFICER',
    422,
    'Link a civilian profile under suspects or witnesses.',
  )
  if (input.profileId)
    check(await tx.profile.findUnique({ where: { id: input.profileId } }), 422, 'Profile not found.')
  if (input.userId)
    check(await tx.user.findUnique({ where: { id: input.userId } }), 422, 'Officer account not found.')
}

async function personChanged(
  tx: Database,
  caseId: string,
  user: Actor,
  personId: string,
  action: string,
  details: unknown,
) {
  await tx.case.update({ where: { id: caseId }, data: { version: { increment: 1 } } })
  await audit(tx, user.id, action, 'person', personId, auditValues(details), caseId)
}

cases.patch('/:id/persons/:personId', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const personId = id.parse(req.params.personId)
  const { version: expected, ...input } = personInput.parse(req.body)
  await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, expected)
    const before = await tx.casePerson.findFirst({ where: { id: personId, caseId } })
    check(before, 404, 'Person not found.')
    await validatePerson(tx, input)
    await tx.casePerson.update({ where: { id: personId }, data: input })
    await personChanged(tx, caseId, user, personId, 'person.updated', { before, after: input })
  })
  publish({ caseId })
  res.sendStatus(204)
})

cases.post('/:id/persons/:personId/profile', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const personId = id.parse(req.params.personId)
  const input = z.object({ version }).parse(req.body)
  const profile = await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, input.version)
    const person = await tx.casePerson.findFirst({ where: { id: personId, caseId } })
    check(
      person && person.role !== 'OFFICER' && !person.profileId,
      409,
      'Choose an unlinked civilian or suspect on this case.',
    )
    const profile = await tx.profile.create({ data: { fullName: person.name }, select: { id: true } })
    await tx.casePerson.update({ where: { id: personId }, data: { profileId: profile.id } })
    // The unit-wide profile audit never identifies the source case.
    await audit(tx, user.id, 'profile.created', 'profile', profile.id, { fullName: person.name })
    await personChanged(tx, caseId, user, personId, 'person.profile_linked', { profileId: profile.id })
    return profile
  })
  publish({ caseId })
  res.status(201).json(profile)
})

cases.delete('/:id/persons/:personId', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const personId = id.parse(req.params.personId)
  const input = z.object({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, input.version)
    const before = await tx.casePerson.findFirst({ where: { id: personId, caseId } })
    check(before, 404, 'Person not found.')
    await tx.casePerson.delete({ where: { id: personId } })
    await personChanged(tx, caseId, user, personId, 'person.removed', { before })
  })
  publish({ caseId })
  res.sendStatus(204)
})

cases.post('/:id/related', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const input = z.object({ toId: id, explanation: requiredText(1000), version }).parse(req.body)
  check(caseId !== input.toId, 422, 'Choose another case.')
  await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, input.version)
    await scopedCase(tx, user, input.toId)
    await tx.relatedCase.upsert({
      where: { fromId_toId: { fromId: caseId, toId: input.toId } },
      create: { fromId: caseId, toId: input.toId, explanation: input.explanation },
      update: { explanation: input.explanation },
    })
    await tx.case.update({ where: { id: caseId }, data: { version: { increment: 1 } } })
    await audit(
      tx,
      user.id,
      'case.related_link_saved',
      'case',
      caseId,
      { toId: input.toId, explanation: input.explanation },
      caseId,
    )
  })
  publish({ caseId })
  res.sendStatus(204)
})

cases.delete('/:id/related/:other', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const otherId = id.parse(req.params.other)
  const input = z.object({ version }).parse(req.body)
  await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, input.version)
    await scopedCase(tx, user, otherId)
    const removed = await tx.relatedCase.deleteMany({ where: { fromId: caseId, toId: otherId } })
    check(removed.count, 404, 'Related case link not found.')
    await tx.case.update({ where: { id: caseId }, data: { version: { increment: 1 } } })
    await audit(tx, user.id, 'case.related_link_removed', 'case', caseId, { toId: otherId }, caseId)
  })
  publish({ caseId })
  res.sendStatus(204)
})

cases.get('/:id/activity', async (req, res) => {
  const caseId = id.parse(req.params.id)
  await scopedCase(db, actor(req), caseId)
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(req.query.page ?? 1)
  const rows = await db.audit.findMany({
    where: { caseId },
    skip: (page - 1) * 30,
    take: 31,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, action: true, target: true, createdAt: true, actor: { select: publicUser } },
  })
  res.json({ items: rows.slice(0, 30), more: rows.length > 30 })
})

import { Router } from 'express'
import { z } from 'zod'
import {
  https,
  id,
  ids,
  imageAllowed,
  requiredText,
  text,
  version,
} from '../../packages/shared/validation.js'
import { actor, lockIdentity, requireAdmin, requireEditor } from './auth.js'
import { audit, auditValues, db, publicUser, type Database } from './db.js'
import { check, checkVersion } from './errors.js'
import { visibleCase } from './access.js'
import { imageHosts } from './settings.js'
import { publish } from './live.js'

const profileData = z.object({
  fullName: requiredText(180),
  aliases: z.array(requiredText(180)).max(30).default([]),
  identifier: text(100).nullable().default(null),
  birthDate: z.iso.date().nullable().default(null),
  contact: text(1200).default(''),
  portraitUrl: https.nullable().default(null),
  confirmedNotes: text(12000).default(''),
  unverifiedNotes: text(12000).default(''),
  tagIds: ids,
})

async function fields(
  tx: Database,
  input: z.infer<typeof profileData>,
  existingPortrait?: string | null,
) {
  const { tagIds, birthDate, ...data } = input
  if (data.portraitUrl && data.portraitUrl !== existingPortrait) {
    check(
      imageAllowed(data.portraitUrl, await imageHosts(tx)),
      422,
      'Use an approved portrait image host.',
    )
  }
  check(
    (await tx.tag.count({ where: { id: { in: tagIds } } })) === tagIds.length,
    422,
    'A selected tag is no longer available.',
  )
  return { ...data, birthDate: birthDate ? new Date(birthDate + 'T00:00:00Z') : null }
}

export const profiles = Router()
profiles.get('/:id', async (req, res) => {
  const profileId = id.parse(req.params.id)
  const record = await db.profile.findUnique({
    where: { id: profileId },
    include: {
      tags: { include: { tag: true } },
      appearances: {
        where: { case: visibleCase(actor(req)) },
        orderBy: { case: { openedAt: 'desc' } },
        select: {
          id: true,
          role: true,
          name: true,
          case: { select: { id: true, title: true, number: true } },
        },
      },
    },
  })
  check(record, 404, 'Profile not found.')
  const history = await db.audit.findMany({
    where: { target: 'profile', targetId: record.id },
    take: 30,
    orderBy: { createdAt: 'desc' },
    select: { id: true, action: true, createdAt: true, actorName: true, actor: { select: publicUser } },
  })
  res.json({ ...record, history })
})

profiles.post('/', async (req, res) => {
  const input = profileData.parse(req.body)
  const record = await db.$transaction(async (tx) => {
    const user = await lockIdentity(tx, req.identity!)
    requireEditor(user)
    const data = await fields(tx, input)
    const record = await tx.profile.create({
      data: { ...data, tags: { create: input.tagIds.map((tagId) => ({ tagId })) } },
    })
    await audit(tx, user.id, 'profile.created', 'profile', record.id, { fullName: record.fullName })
    return record
  })
  publish()
  res.status(201).json(record)
})

profiles.patch('/:id', async (req, res) => {
  const profileId = id.parse(req.params.id)
  const { version: expected, ...input } = profileData.extend({ version }).parse(req.body)
  await db.$transaction(async (tx) => {
    const user = await lockIdentity(tx, req.identity!)
    requireEditor(user)
    await tx.$queryRaw`SELECT id FROM "Profile" WHERE id = ${profileId} FOR UPDATE`
    const record = await tx.profile.findUnique({ where: { id: profileId }, include: { tags: true } })
    check(record, 404, 'Profile not found.')
    check(!record.archivedAt, 409, 'Restore this profile before editing.')
    checkVersion(record.version, expected)
    const data = await fields(tx, input, record.portraitUrl)
    await tx.profile.update({
      where: { id: profileId },
      data: {
        ...data,
        version: { increment: 1 },
        tags: { deleteMany: {}, create: input.tagIds.map((tagId) => ({ tagId })) },
      },
    })
    await audit(
      tx,
      user.id,
      'profile.updated',
      'profile',
      profileId,
      auditValues({ before: record, after: input }),
    )
  })
  publish()
  res.sendStatus(204)
})

profiles.delete('/:id', async (req, res) => {
  requireAdmin(actor(req))
  const profileId = id.parse(req.params.id)
  const input = z.object({ version, confirmation: z.literal('DELETE') }).parse(req.body)
  await db.$transaction(async (tx) => {
    const user = await lockIdentity(tx, req.identity!)
    requireAdmin(user)
    await tx.$queryRaw`SELECT id FROM "Profile" WHERE id = ${profileId} FOR UPDATE`
    const record = await tx.profile.findUnique({ where: { id: profileId } })
    check(record, 404, 'Profile not found.')
    checkVersion(record.version, input.version)
    await tx.$executeRaw`UPDATE "Case" SET version = version + 1
      WHERE id IN (SELECT "caseId" FROM "CasePerson" WHERE "profileId" = ${profileId})`
    await tx.profile.delete({ where: { id: profileId } })
    await audit(tx, user.id, 'profile.deleted', 'profile', profileId)
  })
  publish()
  res.sendStatus(204)
})

profiles.post('/:id/archive', async (req, res) => {
  const profileId = id.parse(req.params.id)
  const input = z.object({ archived: z.boolean(), version }).parse(req.body)
  await db.$transaction(async (tx) => {
    const user = await lockIdentity(tx, req.identity!)
    requireEditor(user)
    const count = await tx.profile.updateMany({
      where: { id: profileId, version: input.version },
      data: {
        archivedAt: input.archived ? new Date() : null,
        version: { increment: 1 },
      },
    })
    check(count.count, 409, 'The profile changed or no longer exists.')
    await audit(
      tx,
      user.id,
      input.archived ? 'profile.archived' : 'profile.restored',
      'profile',
      profileId,
    )
  })
  publish()
  res.sendStatus(204)
})

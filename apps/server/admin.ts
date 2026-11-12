import { Router } from 'express'
import { z } from 'zod'
import { documentTypes, id, requiredText, statusKey, text } from '../../packages/shared/validation.js'
import { actor, lockIdentity, requireAdmin } from './auth.js'
import { audit, db, publicUser, type Actor, type Database } from './db.js'
import { check } from './errors.js'
import { publish } from './live.js'
import { imageHosts } from './settings.js'

export const catalog = Router()
catalog.get('/', async (_req, res) => {
  const [tags, statuses, hosts, templates] = await Promise.all([
    db.tag.findMany({ orderBy: { label: 'asc' } }),
    db.caseStatus.findMany({ orderBy: [{ position: 'asc' }, { label: 'asc' }] }),
    imageHosts(),
    db.template.findMany({ orderBy: { type: 'asc' } }),
  ])
  res.json({ tags, statuses, hosts, templates })
})

export const administration = Router()
administration.use((req, _res, next) => {
  requireAdmin(actor(req))
  next()
})

function change(req: Parameters<typeof actor>[0], work: (tx: Database, user: Actor) => Promise<void>) {
  return db.$transaction(async (tx) => {
    const user = await lockIdentity(tx, req.identity!)
    requireAdmin(user)
    await work(tx, user)
  })
}

administration.get('/catalog', async (_req, res) => {
  const [tags, statuses, hosts, templates, backup] = await Promise.all([
    db.tag.findMany({
      orderBy: { label: 'asc' },
      include: { _count: { select: { cases: true, profiles: true } } },
    }),
    db.caseStatus.findMany({
      orderBy: [{ position: 'asc' }, { label: 'asc' }],
      include: { _count: { select: { cases: true } } },
    }),
    imageHosts(),
    db.template.findMany({ orderBy: { type: 'asc' } }),
    db.setting.findUnique({ where: { key: 'lastBackup' } }),
  ])
  res.json({ tags, statuses, hosts, templates, backup: backup?.value ?? null, database: 'Reachable' })
})

const tagLabel = requiredText(60)
administration.post('/tags', async (req, res) => {
  const label = tagLabel.parse(req.body.label)
  await change(req, async (tx, user) => {
    const tag = await tx.tag.create({ data: { label } })
    await audit(tx, user.id, 'tag.created', 'tag', tag.id, { label })
  })
  publish()
  res.sendStatus(204)
})

administration.patch('/tags/:id', async (req, res) => {
  const tagId = id.parse(req.params.id)
  const label = tagLabel.parse(req.body.label)
  await change(req, async (tx, user) => {
    const before = await tx.tag.findUniqueOrThrow({ where: { id: tagId } })
    await tx.tag.update({ where: { id: tagId }, data: { label } })
    await audit(tx, user.id, 'tag.renamed', 'tag', tagId, { before: before.label, after: label })
  })
  publish()
  res.sendStatus(204)
})

administration.delete('/tags/:id', async (req, res) => {
  const tagId = id.parse(req.params.id)
  const input = z.object({ mergeInto: id.optional() }).parse(req.body ?? {})
  check(input.mergeInto !== tagId, 422, 'Choose a different destination tag.')
  await change(req, async (tx, user) => {
    // Lock both tag rows in a stable order. Any new associations must wait on the foreign key.
    for (const tag of [tagId, ...(input.mergeInto ? [input.mergeInto] : [])].sort()) {
      await tx.$queryRaw`SELECT id FROM "Tag" WHERE id = ${tag} FOR UPDATE`
    }
    const before = await tx.tag.findUniqueOrThrow({ where: { id: tagId }, include: { _count: true } })
    if (input.mergeInto) {
      await tx.tag.findUniqueOrThrow({ where: { id: input.mergeInto } })
      await tx.$executeRaw`INSERT INTO "CaseTag" ("caseId", "tagId")
        SELECT "caseId", ${input.mergeInto} FROM "CaseTag" WHERE "tagId" = ${tagId} ON CONFLICT DO NOTHING`
      await tx.$executeRaw`INSERT INTO "ProfileTag" ("profileId", "tagId")
        SELECT "profileId", ${input.mergeInto} FROM "ProfileTag" WHERE "tagId" = ${tagId} ON CONFLICT DO NOTHING`
    }
    await tx.$executeRaw`UPDATE "Case" SET version = version + 1 WHERE id IN (SELECT "caseId" FROM "CaseTag" WHERE "tagId" = ${tagId})`
    await tx.$executeRaw`UPDATE "Profile" SET version = version + 1 WHERE id IN (SELECT "profileId" FROM "ProfileTag" WHERE "tagId" = ${tagId})`
    await tx.tag.delete({ where: { id: tagId } })
    await audit(tx, user.id, input.mergeInto ? 'tag.merged' : 'tag.deleted', 'tag', tagId, {
      ...before,
      destination: input.mergeInto ?? null,
    })
  })
  publish()
  res.sendStatus(204)
})

const core = ['draft', 'active', 'pending', 'closed', 'archived']
const statusInput = z.object({ label: requiredText(70), position: z.number().int().min(0).max(1000) })
administration.post('/statuses', async (req, res) => {
  const { id, ...data } = statusInput.extend({ id: statusKey }).parse(req.body)
  await change(req, async (tx, user) => {
    await tx.caseStatus.create({ data: { id, ...data } })
    await audit(tx, user.id, 'status.created', 'status', id, data)
  })
  publish()
  res.sendStatus(204)
})
administration.patch('/statuses/:id', async (req, res) => {
  const status = statusKey.parse(req.params.id)
  const data = statusInput.parse(req.body)
  await change(req, async (tx, user) => {
    const before = await tx.caseStatus.findUniqueOrThrow({ where: { id: status } })
    await tx.caseStatus.update({ where: { id: status }, data })
    await audit(tx, user.id, 'status.updated', 'status', status, { before, after: data })
  })
  publish()
  res.sendStatus(204)
})
administration.delete('/statuses/:id', async (req, res) => {
  const status = statusKey.parse(req.params.id)
  const { destination } = z.object({ destination: statusKey.optional() }).parse(req.body ?? {})
  check(!core.includes(status), 409, 'Built-in case statuses are required.')
  check(
    !destination || !['draft', 'closed', 'archived', status].includes(destination),
    422,
    'Choose a different working status.',
  )
  await change(req, async (tx, user) => {
    const where = { OR: [{ statusId: status }, { preArchiveStatus: status }] }
    const used = await tx.case.count({ where })
    check(!used || destination, 409, 'This status is in use. Choose a replacement status.')
    if (destination) {
      await tx.caseStatus.findUniqueOrThrow({ where: { id: destination } })
      await tx.case.updateMany({
        where: { statusId: status },
        data: { statusId: destination, version: { increment: 1 } },
      })
      await tx.case.updateMany({
        where: { preArchiveStatus: status },
        data: { preArchiveStatus: destination, version: { increment: 1 } },
      })
    }
    await tx.caseStatus.delete({ where: { id: status } })
    await audit(tx, user.id, 'status.deleted', 'status', status, {
      destination: destination ?? null,
      used,
    })
  })
  publish()
  res.sendStatus(204)
})

administration.put('/templates/:type', async (req, res) => {
  const type = z.enum(documentTypes).parse(req.params.type)
  const headings = z.array(requiredText(150)).max(30).parse(req.body.headings)
  await change(req, async (tx, user) => {
    const before = await tx.template.findUnique({ where: { type } })
    await tx.template.upsert({ where: { type }, create: { type, headings }, update: { headings } })
    await audit(tx, user.id, 'template.updated', 'template', type, {
      before: before?.headings ?? [],
      after: headings,
    })
  })
  publish()
  res.sendStatus(204)
})

administration.put('/hosts', async (req, res) => {
  const hostname = z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  const hosts = [...new Set(z.array(hostname).max(40).parse(req.body.hosts))]
  check(
    hosts.every(
      (host) =>
        !['local', 'localhost', 'internal', 'test', 'invalid'].includes(host.split('.').at(-1)!),
    ),
    422,
    'Use public DNS hostnames.',
  )
  await change(req, async (tx, user) => {
    const before = await imageHosts(tx)
    await tx.setting.upsert({
      where: { key: 'imageHosts' },
      create: { key: 'imageHosts', value: hosts },
      update: { value: hosts },
    })
    await audit(tx, user.id, 'settings.image_hosts_updated', 'setting', 'imageHosts', {
      before,
      after: hosts,
    })
  })
  publish()
  res.sendStatus(204)
})

administration.get('/audit', async (req, res) => {
  const { q, page } = z
    .object({ q: text(160).default(''), page: z.coerce.number().int().min(1).max(10000).default(1) })
    .parse(req.query)
  const contains = { contains: q, mode: 'insensitive' as const }
  const caseIds = q
    ? await db.case.findMany({
        where: { OR: [{ number: contains }, { title: contains }] },
        select: { id: true },
        take: 100,
      })
    : []
  const rows = await db.audit.findMany({
    where: q
      ? {
          OR: [
            { action: contains },
            { target: contains },
            { targetId: contains },
            { actor: { username: contains } },
            { caseId: { in: caseIds.map((item) => item.id) } },
          ],
        }
      : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * 30,
    take: 31,
    include: { actor: { select: publicUser } },
  })
  res.json({ items: rows.slice(0, 30), more: rows.length > 30 })
})

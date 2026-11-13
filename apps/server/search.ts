import { Router } from 'express'
import { z } from 'zod'
import { id, searchFilters, requiredText, text } from '../../packages/shared/validation.js'
import { Prisma } from '../../generated/prisma/client.js'
import { actor } from './auth.js'
import { db, publicUser, type Actor } from './db.js'
import { caseCard, taskFields } from './cases.js'
import { scopedCase, visibleCase } from './access.js'
import { publish } from './live.js'
import { check } from './errors.js'

const size = 25
const literal = (q: string) => '%' + q.replace(/[\\%_]/g, '\\$&') + '%'
type Filters = z.infer<typeof searchFilters>

function sqlVisibility(user: Actor) {
  if (user.role === 'ADMIN') return Prisma.sql`TRUE`
  return Prisma.sql`(NOT c.restricted OR c."leadId" = ${user.id} OR EXISTS (
    SELECT 1 FROM "CaseMember" cm WHERE cm."caseId" = c.id AND cm."userId" = ${user.id}
  ))`
}

async function searchCases(user: Actor, filters: Filters) {
  const { q, status, priority, tagId, investigator, from, to, archived, page } = filters
  const where: Prisma.Sql[] = [sqlVisibility(user)]
  if (!archived) where.push(Prisma.sql`c."archivedAt" IS NULL`)
  if (archived === 'only') where.push(Prisma.sql`c."archivedAt" IS NOT NULL`)
  if (status) where.push(Prisma.sql`c."statusId" = ${status}`)
  if (priority) where.push(Prisma.sql`c.priority = ${priority}::"Priority"`)
  if (tagId)
    where.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "CaseTag" ct WHERE ct."caseId" = c.id AND ct."tagId" = ${tagId})`,
    )
  if (investigator)
    where.push(Prisma.sql`(c."leadId" = ${investigator} OR EXISTS (
    SELECT 1 FROM "CaseMember" cm WHERE cm."caseId" = c.id AND cm."userId" = ${investigator}))`)
  const timeZone = filters.timeZone ?? 'UTC'
  if (from)
    where.push(Prisma.sql`COALESCE(c."occurredAt", c."openedAt") >=
    ((${from}::date::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC')`)
  if (to)
    where.push(Prisma.sql`COALESCE(c."occurredAt", c."openedAt") <
    (((${to}::date + 1)::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC')`)
  if (q) {
    const match = literal(q)
    where.push(Prisma.sql`(
      c.number ILIKE ${match} OR c.title ILIKE ${match} OR
      EXISTS (SELECT 1 FROM "CasePerson" suspect JOIN "SuspectCharge" charge ON charge."personId" = suspect.id
        WHERE suspect."caseId" = c.id AND (charge.code ILIKE ${match} OR charge.title ILIKE ${match})) OR
      to_tsvector('simple', c.title || ' ' || c.summary) @@ websearch_to_tsquery('simple', ${q}) OR
      EXISTS (SELECT 1 FROM "Document" d WHERE d."caseId" = c.id AND d."removedAt" IS NULL AND
        to_tsvector('simple', d.title || ' ' || d."plainText") @@ websearch_to_tsquery('simple', ${q})) OR
      EXISTS (SELECT 1 FROM "CaseTag" ct JOIN "Tag" t ON t.id = ct."tagId" WHERE ct."caseId" = c.id AND t.label ILIKE ${match}) OR
      EXISTS (SELECT 1 FROM "CasePerson" cp LEFT JOIN "Profile" p ON p.id = cp."profileId" LEFT JOIN "User" u ON u.id = cp."userId"
        WHERE cp."caseId" = c.id AND (cp.name ILIKE ${match} OR p."fullName" ILIKE ${match} OR u."displayName" ILIKE ${match}
          OR u.badge ILIKE ${match} OR p.identifier ILIKE ${match}
          OR EXISTS (SELECT 1 FROM unnest(p.aliases) AS a(alias) WHERE a.alias ILIKE ${match}))) OR
      EXISTS (SELECT 1 FROM "User" u WHERE (u.id = c."leadId" OR EXISTS (
        SELECT 1 FROM "CaseMember" cm WHERE cm."caseId" = c.id AND cm."userId" = u.id))
        AND (u."displayName" ILIKE ${match} OR u.badge ILIKE ${match}))
    )`)
  }
  const candidates = await db.$queryRaw<{ id: string; exact: boolean }[]>`
    SELECT c.id, lower(c.number) = lower(${q}) AS exact FROM "Case" c
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY exact DESC, c."updatedAt" DESC, c.id
    LIMIT ${size + 1} OFFSET ${(page - 1) * size}
  `
  const records = await db.case.findMany({
    where: { id: { in: candidates.slice(0, size).map((row) => row.id) }, ...visibleCase(user) },
    select: caseCard,
  })
  const byId = new Map(records.map((record) => [record.id, record]))
  const items = candidates.slice(0, size).flatMap((row) => {
    const record = byId.get(row.id)
    return record ? [{ ...record, exact: row.exact }] : []
  })
  return { items, more: candidates.length > size }
}

async function searchProfiles(q: string, page: number, archived: Filters['archived']) {
  const match = literal(q)
  const visibility =
    archived === 'include'
      ? Prisma.sql`TRUE`
      : archived === 'only'
        ? Prisma.sql`p."archivedAt" IS NOT NULL`
        : Prisma.sql`p."archivedAt" IS NULL`
  const items = await db.$queryRaw<
    {
      id: string
      fullName: string
      aliases: string[]
      identifier: string | null
      archivedAt: Date | null
      exact: boolean
    }[]
  >`
    SELECT p.id, p."fullName", p.aliases, p.identifier, p."archivedAt",
      COALESCE(lower(p.identifier) = lower(${q}) AND ${q} <> '', false) AS exact
    FROM "Profile" p WHERE ${visibility}
      AND (p."fullName" ILIKE ${match} OR p.identifier ILIKE ${match}
        OR EXISTS (SELECT 1 FROM unnest(p.aliases) AS a(alias) WHERE a.alias ILIKE ${match}))
    ORDER BY exact DESC, p."fullName", p.id LIMIT ${size + 1} OFFSET ${(page - 1) * size}
  `
  return { items: items.slice(0, size), more: items.length > size }
}

export const search = Router()
search.get('/cases', async (req, res) =>
  res.json(await searchCases(actor(req), searchFilters.parse(req.query))),
)
search.get('/profiles', async (req, res) => {
  const { q, page, archived } = searchFilters.parse(req.query)
  res.json(await searchProfiles(q, page, archived))
})

search.get('/officers', async (req, res) => {
  const q = text(100).parse(req.query.q ?? '')
  const items = await db.user.findMany({
    where: {
      disabledAt: null,
      OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
        { badge: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: publicUser,
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 25,
  })
  res.json({ items })
})

search.get('/dashboard', async (req, res) => {
  const user = actor(req)
  const visibility = visibleCase(user)
  const orderBy = [{ updatedAt: 'desc' as const }, { id: 'desc' as const }]
  const mine = { OR: [{ leadId: user.id }, { members: { some: { userId: user.id } } }] }
  const tasks = {
    assigneeId: user.id,
    status: { not: 'DONE' as const },
    case: { ...visibility, archivedAt: null, statusId: { not: 'closed' } },
  }
  const taskInclude = { ...taskFields, case: { select: { id: true, number: true, title: true } } }
  const [myCases, recent, pinned, myTasks, overdue, saved] = await Promise.all([
    db.case.findMany({
      where: { AND: [visibility, mine], archivedAt: null },
      select: caseCard,
      orderBy,
      take: 10,
    }),
    db.case.findMany({
      where: { ...visibility, archivedAt: null },
      select: caseCard,
      orderBy,
      take: 10,
    }),
    db.case.findMany({
      where: { ...visibility, favorites: { some: { userId: user.id } } },
      select: caseCard,
      orderBy,
      take: 10,
    }),
    db.task.findMany({
      where: tasks,
      include: taskInclude,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: 20,
    }),
    db.task.findMany({
      where: { ...tasks, dueAt: { lt: new Date() } },
      include: taskInclude,
      orderBy: { dueAt: 'asc' },
      take: 20,
    }),
    db.savedSearch.findMany({ where: { userId: user.id }, orderBy: { label: 'asc' }, take: 50 }),
  ])
  res.json({ myCases, recent, pinned, myTasks, overdue, saved })
})

search.put('/favorites/:id', async (req, res) => {
  const user = actor(req)
  const caseId = id.parse(req.params.id)
  const value = z.object({ pinned: z.boolean() }).parse(req.body)
  await scopedCase(db, user, caseId)
  if (value.pinned) {
    await db.favorite.upsert({
      where: { userId_caseId: { userId: user.id, caseId } },
      create: { userId: user.id, caseId },
      update: {},
    })
  } else await db.favorite.deleteMany({ where: { caseId, userId: user.id } })
  publish({ userId: user.id })
  res.sendStatus(204)
})

search.post('/saved', async (req, res) => {
  const { label, filters } = z
    .object({ label: requiredText(80), filters: searchFilters })
    .parse(req.body)
  const userId = actor(req).id
  check(
    (await db.savedSearch.count({ where: { userId } })) < 50,
    409,
    'Remove a saved search before adding another.',
  )
  const result = await db.savedSearch.create({
    data: { label, filters: { ...filters, page: 1 }, userId },
  })
  publish({ userId })
  res.status(201).json(result)
})
search.delete('/saved/:id', async (req, res) => {
  const userId = actor(req).id
  await db.savedSearch.deleteMany({ where: { userId, id: id.parse(req.params.id) } })
  publish({ userId })
  res.sendStatus(204)
})

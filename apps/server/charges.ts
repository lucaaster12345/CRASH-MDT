import { Router } from 'express'
import { z } from 'zod'
import { chargeTotals } from '../../packages/shared/charges.js'
import { id, requiredText, text, version } from '../../packages/shared/validation.js'
import { actor, lockIdentity, requireAdmin } from './auth.js'
import { visibleCase, withCase } from './access.js'
import { audit, auditValues, db, type Database } from './db.js'
import { check, checkVersion } from './errors.js'
import { publish } from './live.js'

const terms = {
  code: requiredText(40).toUpperCase(),
  title: requiredText(180),
  description: text(4000).default(''),
  custodyMinutes: z.number().int().min(0).max(10_000_000),
  fineCents: z.number().int().min(0).max(1_000_000_000),
}
const pageSize = 25

export const penalCode = Router()
penalCode.get('/', async (req, res) => {
  const { q, page, archived } = z
    .object({
      q: text(120).default(''),
      page: z.coerce.number().int().min(1).max(10000).default(1),
      archived: z.enum(['yes', 'all']).optional(),
    })
    .parse(req.query)
  const contains = { contains: q, mode: 'insensitive' as const }
  const rows = await db.penalCharge.findMany({
    where: {
      ...(archived === 'all' ? {} : { archivedAt: archived === 'yes' ? { not: null } : null }),
      ...(q ? { OR: [{ code: contains }, { title: contains }] } : {}),
    },
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  })
  res.json({ items: rows.slice(0, pageSize), more: rows.length > pageSize })
})

penalCode.post('/', async (req, res) => {
  requireAdmin(actor(req))
  const input = z.object(terms).parse(req.body)
  const charge = await db.$transaction(async (tx) => {
    const user = await lockIdentity(tx, req.identity!)
    requireAdmin(user)
    const saved = await tx.penalCharge.create({ data: input })
    await audit(tx, user.id, 'charge.created', 'charge', saved.id, auditValues(saved))
    return saved
  })
  publish()
  res.status(201).json(charge)
})

penalCode.patch('/:id', async (req, res) => {
  requireAdmin(actor(req))
  const chargeId = id.parse(req.params.id)
  const { version: expected, ...input } = z
    .object({ ...terms, archived: z.boolean(), version })
    .parse(req.body)
  const { archived, ...values } = input
  await db.$transaction(async (tx) => {
    const user = await lockIdentity(tx, req.identity!)
    requireAdmin(user)
    const where = { id: chargeId }
    const before = await tx.penalCharge.findUnique({ where })
    check(before, 404, 'Charge not found.')
    checkVersion(before.version, expected)
    const changed = await tx.penalCharge.updateMany({
      where: { ...where, version: expected },
      data: {
        ...values,
        archivedAt: archived ? (before.archivedAt ?? new Date()) : null,
        version: { increment: 1 },
      },
    })
    check(changed.count, 409, 'This charge was edited. Reload it before saving.')
    const after = await tx.penalCharge.findUniqueOrThrow({ where })
    await audit(tx, user.id, 'charge.updated', 'charge', chargeId, auditValues({ before, after }))
  })
  publish()
  res.sendStatus(204)
})

export async function suspectChargeSummary(tx: Database, caseId: string) {
  const suspects = await tx.casePerson.findMany({
    where: { caseId, role: 'SUSPECT', charges: { some: {} } },
    select: {
      id: true,
      name: true,
      charges: {
        orderBy: { code: 'asc' },
        select: {
          chargeId: true,
          code: true,
          title: true,
          custodyMinutes: true,
          fineCents: true,
          count: true,
        },
      },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  return suspects.map(({ id, name, charges }) => ({
    personId: id,
    name,
    charges,
    ...chargeTotals(charges),
  }))
}

export const caseCharges = Router()
caseCharges.get('/:id/charges', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const summary = await db.$transaction(
    async (tx) => {
      const record = await tx.case.findFirst({
        where: { id: caseId, ...visibleCase(actor(req)) },
        select: { chargeVersion: true },
      })
      check(record, 404, 'Case not found or access has changed.')
      return { version: record.chargeVersion, suspects: await suspectChargeSummary(tx, caseId) }
    },
    { isolationLevel: 'RepeatableRead' },
  )
  res.json(summary)
})

caseCharges.put('/:id/persons/:personId/charges', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const personId = id.parse(req.params.personId)
  const input = z
    .object({
      version,
      charges: z
        .array(
          z.object({
            chargeId: id,
            count: z.number().int().min(1).max(100),
            catalogVersion: version.optional(),
          }),
        )
        .max(100),
    })
    .parse(req.body)
  check(
    new Set(input.charges.map((line) => line.chargeId)).size === input.charges.length,
    422,
    'Combine duplicate entries using the count.',
  )
  await withCase(req, caseId, async (tx, user, record) => {
    checkVersion(record.version, input.version)
    const person = await tx.casePerson.findFirst({
      where: { id: personId, caseId, role: 'SUSPECT' },
      include: { charges: true },
    })
    check(person, 404, 'Suspect not found on this case.')
    const prior = new Map(person.charges.map((line) => [line.chargeId, line]))
    const newIds = input.charges.map((line) => line.chargeId).filter((chargeId) => !prior.has(chargeId))
    const catalog = await tx.penalCharge.findMany({ where: { id: { in: newIds }, archivedAt: null } })
    const byId = new Map(catalog.map((charge) => [charge.id, charge]))
    const next = input.charges.map(({ chargeId, count, catalogVersion }) => {
      const entry = byId.get(chargeId)
      const values = prior.get(chargeId) ?? entry
      check(values, 422, 'An added charge is no longer available. Refresh the penal code.')
      if (entry && catalogVersion !== undefined) checkVersion(entry.version, catalogVersion)
      const { code, title, custodyMinutes, fineCents } = values
      return { personId, chargeId, count, code, title, custodyMinutes, fineCents }
    })
    if (
      next.length === prior.size &&
      next.every((line) => prior.get(line.chargeId)?.count === line.count)
    )
      return
    await tx.suspectCharge.deleteMany({ where: { personId } })
    await tx.suspectCharge.createMany({ data: next })
    await tx.case.update({
      where: { id: caseId },
      data: { version: { increment: 1 }, chargeVersion: { increment: 1 } },
    })
    await audit(
      tx,
      user.id,
      'person.charges_updated',
      'person',
      personId,
      auditValues({ before: person.charges, after: next }),
      caseId,
    )
  })
  publish({ caseId })
  res.sendStatus(204)
})

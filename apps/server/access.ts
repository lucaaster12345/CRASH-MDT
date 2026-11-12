import type { Request } from 'express'
import type { Prisma } from '../../generated/prisma/client.js'
import { db, type Actor, type Database } from './db.js'
import { check } from './errors.js'
import { canEdit, lockIdentity, requireEditor } from './auth.js'
import { inCaseGate } from './gates.js'

export function visibleCase(user: Actor): Prisma.CaseWhereInput {
  if (user.role === 'ADMIN') return {}
  return {
    OR: [{ restricted: false }, { leadId: user.id }, { members: { some: { userId: user.id } } }],
  }
}

export function caseWritable(status: string) {
  return status !== 'closed' && status !== 'archived'
}
export function isCaseEditor(user: Actor, status: string) {
  return canEdit(user) && caseWritable(status)
}

export async function lockCase(tx: Database, caseId: string) {
  await tx.$queryRaw`SELECT id FROM "Case" WHERE id = ${caseId} FOR UPDATE`
}

export async function scopedCase(tx: Database, user: Actor, caseId: string) {
  const record = await tx.case.findFirst({ where: { id: caseId, ...visibleCase(user) } })
  check(record, 404, 'Case not found or access has changed.')
  return record
}

export function withCase<T>(
  req: Request,
  caseId: string,
  work: (tx: Database, user: Actor, record: Awaited<ReturnType<typeof scopedCase>>) => Promise<T>,
  lifecycle = false,
) {
  return inCaseGate(caseId, () =>
    db.$transaction(async (tx) => {
      const user = await lockIdentity(tx, req.identity!)
      requireEditor(user)
      await lockCase(tx, caseId)
      const record = await scopedCase(tx, user, caseId)
      check(
        lifecycle || caseWritable(record.statusId),
        409,
        'Reopen or restore this case before editing.',
      )
      return work(tx, user, record)
    }),
  )
}

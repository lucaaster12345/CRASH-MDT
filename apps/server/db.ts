import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from '../../generated/prisma/client.js'
import { config } from './config.js'

export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.database, max: 12 }),
})

export type Database = Prisma.TransactionClient
export const publicUser = {
  id: true,
  username: true,
  displayName: true,
  badge: true,
  role: true,
} as const
export type Actor = Prisma.UserGetPayload<{ select: typeof publicUser }>

export async function audit(
  tx: Database,
  actorId: string | null,
  action: string,
  target: string,
  targetId: string,
  details?: Prisma.InputJsonValue,
  caseId?: string,
) {
  const actor =
    actorId && (await tx.user.findUnique({ where: { id: actorId }, select: { displayName: true } }))
  await tx.audit.create({
    data: {
      actorId,
      actorName: actor ? actor.displayName : null,
      action,
      target,
      targetId,
      details,
      caseId,
    },
  })
}

export function auditValues(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

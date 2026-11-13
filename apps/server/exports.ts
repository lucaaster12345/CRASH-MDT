import { Router } from 'express'
import { z } from 'zod'
import { id, isLegalDocument } from '../../packages/shared/validation.js'
import { actor } from './auth.js'
import { audit, db } from './db.js'
import { getCase } from './cases.js'
import { visibleCase } from './access.js'
import { suspectChargeSummary } from './charges.js'

export const exports = Router()
exports.post('/:id/export', async (req, res) => {
  const caseId = id.parse(req.params.id)
  const input = z
    .object({
      documents: z.array(id).max(200),
      evidence: z.boolean(),
      tasks: z.boolean(),
      charges: z.boolean().default(true),
    })
    .parse(req.body)
  const user = actor(req)
  const payload = await db.$transaction(
    async (tx) => {
      const record = await getCase(tx, user, caseId)
      const docs = await tx.document.findMany({
        where: { caseId, id: { in: input.documents }, removedAt: null, case: visibleCase(user) },
        select: {
          id: true,
          title: true,
          type: true,
          plainText: true,
          stateHash: true,
          updatedAt: true,
          submitted: {
            select: {
              plainText: true,
              createdAt: true,
              stateHash: true,
              chargeVersion: true,
              chargeSummary: true,
            },
          },
        },
        orderBy: { type: 'asc' },
      })
      const {
        documents: _documents,
        evidence,
        tasks,
        favorites: _favorites,
        preArchiveStatus: _preArchiveStatus,
        ...base
      } = record
      const documents = docs.map(({ submitted, stateHash, ...document }) => ({
        ...document,
        submitted: submitted && { plainText: submitted.plainText, createdAt: submitted.createdAt },
        legalDraft: isLegalDocument(document.type),
        amended:
          !!submitted &&
          (submitted.stateHash !== stateHash ||
            (submitted.chargeVersion ?? 0) !== record.chargeVersion),
      }))
      await audit(
        tx,
        user.id,
        'case.exported',
        'case',
        caseId,
        {
          documentIds: documents.map((doc) => doc.id),
          evidence: input.evidence,
          tasks: input.tasks,
          charges: input.charges,
        },
        caseId,
      )
      return {
        format: 'CRASH-MDT case packet v1',
        exportedAt: new Date(),
        case: { ...base, persons: base.persons.map(({ charges: _charges, ...person }) => person) },
        documents,
        charges: input.charges ? await suspectChargeSummary(tx, caseId) : [],
        submittedCharges: input.charges
          ? (docs.find((doc) => doc.type === 'INCIDENT')?.submitted?.chargeSummary ?? null)
          : null,
        evidence: input.evidence ? evidence : [],
        tasks: input.tasks ? tasks : [],
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
  res.json(payload)
})

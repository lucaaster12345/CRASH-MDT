import type { z } from 'zod'
import type { getCase, caseCard, documentMeta, taskFields } from '../../server/cases.js'
import type { Actor } from '../../server/db.js'
import type {
  CaseStatus,
  PenalCharge,
  Profile,
  Prisma,
  Tag,
  Template,
} from '../../../generated/prisma/client.js'
import type { SuspectChargeSummary } from '../../../packages/shared/charges.js'
import type { searchFilters } from '../../../packages/shared/validation.js'

type Wire<T> = T extends Date
  ? string
  : T extends (infer Value)[]
    ? Wire<Value>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T
export type User = Actor
export type Session = { user: User; csrf: string }
export type Page<T> = { items: T[]; more: boolean }
export type RecordRef = { id: string; label: string }
export type CaseCard = Wire<Prisma.CaseGetPayload<{ select: typeof caseCard }>> & { exact?: boolean }
export type CaseRecord = Wire<Awaited<ReturnType<typeof getCase>>>
export type DocumentMeta = Wire<Prisma.DocumentGetPayload<{ select: typeof documentMeta }>>
export type DocumentRecord = DocumentMeta & {
  writable: boolean
  meaningful: boolean
  case: { id: string; number: string; title: string; statusId: string; chargeVersion: number }
}
export type ProfileCard = Pick<
  Wire<Profile>,
  'id' | 'fullName' | 'aliases' | 'identifier' | 'archivedAt'
> & { exact?: boolean }
export type ProfileRecord = Wire<Profile> & {
  tags: { tagId: string; tag: Tag }[]
  appearances: {
    id: string
    role: CaseRecord['persons'][number]['role']
    name: string
    case: { id: string; number: string; title: string }
  }[]
  history: Activity[]
}
export type Activity = {
  id: string
  action: string
  createdAt: string
  actorName?: string | null
  actor: { displayName: string } | null
  details?: unknown
  target?: string
  targetId?: string
}
export type Catalog = { tags: Tag[]; statuses: CaseStatus[]; hosts: string[]; templates: Template[] }
export type AdminCatalog = Omit<Catalog, 'tags' | 'statuses'> & {
  tags: (Tag & { _count: { cases: number; profiles: number } })[]
  statuses: (CaseStatus & { _count: { cases: number } })[]
  database: string
  backup: { at?: string; file?: string } | null
}
export type Account = User & {
  disabledAt: string | null
  createdAt: string
  activated: boolean
  version: number
}
export type Charge = Wire<PenalCharge>
export type Credential = { code: string; expiresAt: string }
export type SavedSearch = { id: string; label: string; filters: Partial<z.infer<typeof searchFilters>> }
export type DashboardData = {
  myCases: CaseCard[]
  recent: CaseCard[]
  pinned: CaseCard[]
  myTasks: TaskCard[]
  overdue: TaskCard[]
  saved: SavedSearch[]
}
export type TaskCard = Wire<Prisma.TaskGetPayload<{ include: typeof taskFields }>> & {
  case: { id: string; number: string; title: string }
}
export type Revision = {
  id: string
  label: string
  kind: string
  createdAt: string
  actorName: string | null
  actor: User | null
}
export type Durable = { epoch: number; stateHash: string; failed: boolean }
export type Packet = {
  format: string
  exportedAt: string
  case: Omit<
    CaseRecord,
    'persons' | 'documents' | 'evidence' | 'tasks' | 'favorites' | 'preArchiveStatus'
  > & {
    persons: Omit<CaseRecord['persons'][number], 'charges'>[]
  }
  documents: {
    id: string
    title: string
    type: DocumentMeta['type']
    plainText: string
    amended: boolean
    legalDraft: boolean
    submitted: { plainText: string; createdAt: string } | null
  }[]
  charges: SuspectChargeSummary[]
  submittedCharges: SuspectChargeSummary[] | null
  evidence: CaseRecord['evidence']
  tasks: CaseRecord['tasks']
}
export type Paths = 'cases' | 'profiles' | 'documents'

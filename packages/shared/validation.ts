import { z } from 'zod'

export const roles = ['ADMIN', 'INVESTIGATOR', 'VIEWER'] as const
export const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export const personRoles = ['SUSPECT', 'WITNESS', 'OFFICER'] as const
export const legalDocumentTypes = ['SUBPOENA', 'WARRANT_REQUEST', 'AFFIDAVIT', 'LEGAL_REQUEST'] as const
export function isLegalDocument(type: string) {
  return legalDocumentTypes.some((value) => value === type)
}
export const documentTypes = [
  'INCIDENT',
  'INTERROGATION',
  'INTERVIEW',
  'ARREST',
  'SUPPLEMENTAL',
  'SURVEILLANCE',
  ...legalDocumentTypes,
  'NOTES',
] as const
export const taskStatuses = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const
export const evidenceTypes = ['IMAGE', 'LINK', 'NOTE'] as const
export const masterUsername = 'mercia'
export const defaultImageHosts = [
  'femboy.beauty',
  'i.imgur.com',
  'imgur.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
]

export const id = z.uuid()
export const text = (max: number) => z.string().trim().max(max)
export const requiredText = (max: number) => text(max).min(1)
export const nullableId = id.nullable().default(null)
export const username = text(48)
  .toLowerCase()
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,47}$/))
export const password = z.string().min(12).max(128)
export const version = z.number().int().positive()
export const isoTime = z.iso.datetime({ offset: true }).nullable().default(null)
export const ids = z
  .array(id)
  .max(100)
  .default([])
  .transform((values) => [...new Set(values)])
export const priority = z.enum(priorities)
export const statusKey = z.string().regex(/^[a-z0-9-]{1,48}$/)
export const https = z
  .string()
  .max(4096)
  .refine((value) => safeHttps(value) !== null, 'Enter an HTTPS URL without credentials.')
export const searchFilters = z.object({
  q: text(160).default(''),
  status: statusKey.optional(),
  priority: priority.optional(),
  tagId: id.optional(),
  investigator: id.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  timeZone: z
    .string()
    .max(100)
    .regex(/^[A-Za-z][A-Za-z0-9_+/-]*$/)
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone })
        return true
      } catch {
        return false
      }
    }, 'Use a valid timezone.')
    .optional(),
  archived: z.enum(['include', 'only']).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
})

export const labels = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
  ADMIN: 'Administrator',
  INVESTIGATOR: 'Investigator',
  VIEWER: 'Viewer',
  SUSPECT: 'Suspects',
  WITNESS: 'Civilians and witnesses',
  OFFICER: 'Involved officers',
  INCIDENT: 'Main incident report',
  INTERROGATION: 'Interrogation transcript',
  INTERVIEW: 'Witness interview',
  ARREST: 'Arrest report',
  SUPPLEMENTAL: 'Supplemental incident report',
  SURVEILLANCE: 'Observation notes',
  SUBPOENA: 'Subpoena draft',
  WARRANT_REQUEST: 'Warrant request draft',
  AFFIDAVIT: 'Affidavit draft',
  LEGAL_REQUEST: 'Legal request draft',
  NOTES: 'Investigative notes',
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
  IMAGE: 'Image',
  LINK: 'Link',
  NOTE: 'Note',
} as const

export function safeHttps(input: string): URL | null {
  // URL normalizes some control characters, so reject them before parsing.
  // eslint-disable-next-line no-control-regex
  if (/\s|[\\\u0000-\u001f\u007f]/u.test(input) || !/^https:\/\//i.test(input)) return null
  try {
    const url = new URL(input)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null
  } catch {
    return null
  }
}

export function imageAllowed(input: string, hosts: readonly string[]): boolean {
  const url = safeHttps(input)
  return !!url && hosts.includes(url.hostname)
}

export function directImage(input: string): boolean {
  const url = safeHttps(input)
  if (!url) return false
  if (url.hostname === 'imgur.com' && /^\/(?:a|gallery)\//.test(url.pathname)) return false
  return (
    /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(url.pathname) ||
    (url.hostname === 'femboy.beauty' && url.pathname.length > 1)
  )
}

export function meaningfulNarrative(value: string): boolean {
  const words = value.match(/[\p{L}\p{N}]+/gu) ?? []
  return words.length >= 4 && words.join('').length >= 20
}

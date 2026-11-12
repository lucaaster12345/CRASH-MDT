export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

let csrf = ''
let handlers: { signedOut: () => void; change: () => void } | null = null
export function configureApi(token: string, next: typeof handlers) {
  csrf = token
  handlers = next
}
export function query(values: Record<string, unknown>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== '' && value !== null && value !== undefined) params.set(key, String(value))
  }
  const value = params.toString()
  return value ? '?' + value : ''
}

export async function api<T>(
  path: string,
  options: { method?: string; data?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = 'GET', data, signal } = options
  const headers = new Headers({ Accept: 'application/json' })
  if (method !== 'GET' && csrf) headers.set('X-CSRF-Token', csrf)
  if (data !== undefined) headers.set('Content-Type', 'application/json')
  const response = await fetch('/api' + path, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (response.status === 401) handlers?.signedOut()
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new ApiError(response.status, error?.error ?? 'The server could not complete the request.')
  }
  if (method !== 'GET') handlers?.change()
  return response.status === 204 ? (undefined as T) : await response.json()
}
export function errorMessage(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError')
    return 'The request timed out. Refresh to check whether it completed.'
  if (error instanceof TypeError)
    return 'The server is unavailable. Check your connection and try again.'
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

export const string = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
export const nullable = (form: FormData, name: string) => string(form, name) || null
export const selected = (form: FormData, name: string) => form.getAll(name).map(String)
export const lines = (form: FormData, name: string) =>
  string(form, name)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
export const instant = (form: FormData, name: string) => {
  const value = nullable(form, name)
  return value ? value + ':00Z' : null
}
export const dateValue = (value?: string | null) => value?.slice(0, 10) ?? ''
export const timeValue = (value?: string | null) => value?.slice(0, 16) ?? ''

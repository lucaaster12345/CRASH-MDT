import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from './api.js'
import type { Catalog, Session } from './types.js'
import { browserTimeZone } from './local-time.js'

export const SessionContext = createContext<Session | null>(null)
export const LiveContext = createContext({ revision: 0, connected: true, refresh: () => {} })
export const PendingContext = createContext<(key: string, value: boolean) => void>(() => {})
export const NoticeContext = createContext<(message: string) => void>(() => {})

export function useSession() {
  return useContext(SessionContext)!
}
export function useNotice() {
  return useContext(NoticeContext)
}
export function useCatalog() {
  return useResource<Catalog>('/catalog')
}
export function useDate() {
  const timezone = browserTimeZone()
  return (value?: string | null) =>
    value
      ? new Intl.DateTimeFormat('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
          timeZoneName: 'short',
          hourCycle: 'h23',
        }).format(new Date(value))
      : '—'
}

export type Resource<T> = { value: T | null; loading: boolean; error: string; retry: () => void }
export function useResource<T>(path: string | null, live = true): Resource<T> {
  const { revision } = useContext(LiveContext)
  const [manual, setManual] = useState(0)
  const [result, setResult] = useState<{ path: string; value: T | null; error: string } | null>(null)
  const retry = useCallback(() => setManual((value) => value + 1), [])
  const tick = live ? revision : 0
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    void api<T>(path, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setResult({ path, value, error: '' })
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        const hide = error instanceof ApiError && [401, 403, 404].includes(error.status)
        setResult((current) => ({
          path,
          value: !hide && current?.path === path ? current.value : null,
          error: errorMessage(error),
        }))
      })
    return () => controller.abort()
  }, [path, manual, tick])
  return result?.path === path
    ? { value: result.value, error: result.error, loading: false, retry }
    : { value: null, error: '', loading: !!path, retry }
}

export function useDebounce<T>(value: T, milliseconds = 300) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), milliseconds)
    return () => clearTimeout(timer)
  }, [value, milliseconds])
  return settled
}

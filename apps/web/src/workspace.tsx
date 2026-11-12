import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError, configureApi, errorMessage, string } from './api.js'
import { LiveContext, NoticeContext, PendingContext, SessionContext, useResource } from './state.js'
import { AsyncButton, Confirm, Empty, Field, ActionForm, ResourceView } from './ui.js'
import { Dashboard, Directory } from './directory.js'
import { CasePage, NewCase } from './case-page.js'
import { ProfilePage, NewProfile } from './profile-page.js'
import { Administration } from './admin-page.js'
import { PacketPage } from './packet.js'
import type { CaseRecord, DocumentRecord, Paths, ProfileRecord, Session } from './types.js'

type Tab = { kind: Paths; id: string }
const DocumentPage = lazy(() =>
  import('./editor.js').then((module) => ({ default: module.DocumentPage })),
)
const tabPattern = /^\/(cases|profiles|documents)\/([0-9a-f-]{36})$/
const pathOf = (tab: Tab) => '/' + tab.kind + '/' + tab.id
function findTab(path: string): Tab | null {
  const match = tabPattern.exec(path)
  return match ? { kind: match[1] as Paths, id: match[2]! } : null
}
const storageKey = (user: string) => 'crash.open-records.' + user
function readTabs(user: string): Tab[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(storageKey(user)) ?? '[]')
    return Array.isArray(values)
      ? values
          .filter(
            (value): value is Tab =>
              typeof value?.id === 'string' &&
              typeof value?.kind === 'string' &&
              tabPattern.test(pathOf(value)),
          )
          .slice(0, 20)
      : []
  } catch {
    return []
  }
}
function storeTabs(user: string, tabs?: Tab[]) {
  try {
    if (tabs) localStorage.setItem(storageKey(user), JSON.stringify(tabs))
    else localStorage.removeItem(storageKey(user))
  } catch {
    /* Storage may be disabled by the browser. */
  }
}

function Login({ onSession }: { onSession: (session: Session) => void }) {
  const [activation, setActivation] = useState(false)
  const [visible, setVisible] = useState(false)
  return (
    <main className="sign-in">
      <div className="sign-brand">
        <span className="wordmark">C.R.A.S.H.</span>
        <span>Community Resources Against Street Hooligans</span>
      </div>
      <section className="sign-panel">
        <div className="eyeline">Investigation workspace</div>
        <h1>{activation ? 'Activate or reset account' : 'Sign in'}</h1>
        <p className="muted">
          {activation
            ? 'Enter the one-time code issued by your administrator and choose a password.'
            : 'Use your issued unit account to open the MDT.'}
        </p>
        <ActionForm
          key={String(activation)}
          label={activation ? 'Set password' : 'Sign in'}
          submit={async (form) => {
            const data = activation
              ? { code: string(form, 'code'), password: form.get('password') }
              : { username: string(form, 'username'), password: form.get('password') }
            onSession(
              await api<Session>('/auth/' + (activation ? 'activate' : 'login'), {
                method: 'POST',
                data,
              }),
            )
          }}
        >
          {activation ? (
            <Field label="One-time code">
              <input required name="code" autoComplete="one-time-code" spellCheck={false} />
            </Field>
          ) : (
            <Field label="Username">
              <input
                required
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
          )}
          <Field label="Password" hint={activation ? 'Use at least 12 characters.' : undefined}>
            <input
              required
              name="password"
              type={visible ? 'text' : 'password'}
              minLength={activation ? 12 : undefined}
              maxLength={128}
              autoComplete={activation ? 'new-password' : 'current-password'}
            />
          </Field>
          <label className="check">
            <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
            Show password
          </label>
        </ActionForm>
        <button
          type="button"
          className="text-button sign-switch"
          onClick={() => {
            setActivation(!activation)
            setVisible(false)
          }}
        >
          {activation ? 'Back to sign in' : 'Activate account or reset password'}
        </button>
      </section>
    </main>
  )
}

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void api<Session>('/auth/session', { signal: controller.signal })
      .then(setSession)
      .catch((error) => {
        if (!controller.signal.aborted && !(error instanceof ApiError && error.status === 401))
          setFailure(errorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [attempt])

  if (loading)
    return (
      <main className="startup" role="status">
        Opening C.R.A.S.H. MDT…
      </main>
    )
  if (failure)
    return (
      <main className="startup" role="alert">
        <p>{failure}</p>
        <button
          onClick={() => {
            setFailure('')
            setLoading(true)
            setAttempt(attempt + 1)
          }}
        >
          Retry
        </button>
      </main>
    )
  if (!session)
    return (
      <>
        {expired && (
          <div role="status" className="session-expired">
            Your session ended. Sign in to continue.
          </div>
        )}
        <Login
          onSession={(value) => {
            setExpired(false)
            setSession(value)
          }}
        />
      </>
    )
  return (
    <SessionContext.Provider value={session}>
      <Workspace
        key={session.user.id}
        session={session}
        onEnd={(lost) => {
          storeTabs(session.user.id)
          setExpired(lost)
          setSession(null)
        }}
      />
    </SessionContext.Provider>
  )
}

function Workspace({ session, onEnd }: { session: Session; onEnd: (lost: boolean) => void }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [revision, setRevision] = useState(0)
  const [connected, setConnected] = useState(true)
  const [message, setMessage] = useState('')
  const noticeTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const changeTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ending = useRef(onEnd)
  useEffect(() => {
    ending.current = onEnd
  }, [onEnd])

  const active = findTab(pathname)
  const activePath = active && pathOf(active)
  const updatePending = useCallback((key: string, value: boolean) => {
    setPending((current) => (current[key] === value ? current : { ...current, [key]: value }))
  }, [])
  const rename = useCallback((key: string, label: string) => {
    setLabels((current) => (current[key] === label ? current : { ...current, [key]: label }))
  }, [])
  const notice = useCallback((text: string) => {
    clearTimeout(noticeTimeout.current)
    setMessage(text)
    noticeTimeout.current = setTimeout(() => setMessage(''), 6500)
  }, [])
  const refresh = useCallback(() => {
    if (changeTimeout.current) return
    changeTimeout.current = setTimeout(() => {
      changeTimeout.current = undefined
      setRevision((value) => value + 1)
    }, 180)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const saved = readTabs(session.user.id)
    void Promise.all(
      saved.map(async (tab) => {
        try {
          await api(pathOf(tab), { signal: controller.signal })
          return tab
        } catch {
          return null
        }
      }),
    ).then((checked) => {
      if (!controller.signal.aborted) {
        setTabs((current) =>
          [
            ...new Map(
              [...checked.filter((tab): tab is Tab => !!tab), ...current].map((tab) => [
                pathOf(tab),
                tab,
              ]),
            ).values(),
          ].slice(-20),
        )
        setHydrated(true)
      }
    })
    return () => controller.abort()
  }, [session.user.id])

  useEffect(() => {
    const tab = findTab(pathname)
    if (!tab) return
    // Synchronize the record strip when browser navigation enters a direct record URL.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTabs((current) => {
      if (current.some((item) => pathOf(item) === pathname)) return current
      // Never drop a mounted editor automatically.
      return [...current, tab]
    })
  }, [pathname])

  useEffect(() => {
    if (hydrated) storeTabs(session.user.id, tabs.slice(-20))
  }, [hydrated, tabs, session.user.id])

  useEffect(() => {
    const signedOut = () => ending.current(true)
    configureApi(session.csrf, { signedOut, change: refresh })
    const stream = new EventSource('/api/events')
    stream.addEventListener('ready', () => {
      setConnected(true)
      refresh()
    })
    stream.addEventListener('change', refresh)
    stream.addEventListener('heartbeat', refresh)
    stream.addEventListener('signed-out', signedOut)
    stream.onerror = () => {
      setConnected(false)
      void api('/auth/session').catch(() => undefined)
    }
    return () => {
      stream.close()
      configureApi('', null)
      clearTimeout(changeTimeout.current)
      clearTimeout(noticeTimeout.current)
    }
  }, [session.csrf, refresh])

  const hasPending = Object.values(pending).some(Boolean)
  useEffect(() => {
    if (!hasPending) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [hasPending])

  useEffect(() => {
    document.title =
      (activePath
        ? (labels[activePath] ?? 'Record')
        : pathname === '/'
          ? 'Dashboard'
          : pathname.startsWith('/admin')
            ? 'Administration'
            : pathname.startsWith('/profiles')
              ? 'Civilian profiles'
              : 'Cases') + ' · C.R.A.S.H. MDT'
  }, [pathname, activePath, labels])

  async function signOut() {
    await api('/auth/logout', { method: 'POST' })
    ending.current(false)
  }
  function close(tab: Tab) {
    const key = pathOf(tab)
    const index = tabs.findIndex((item) => pathOf(item) === key)
    if (key === activePath) navigate(tabs[index - 1] ? pathOf(tabs[index - 1]!) : '/')
    setTabs((current) => current.filter((item) => pathOf(item) !== key))
    updatePending(key, false)
  }

  let general: ReactNode = null
  if (pathname === '/') general = <Dashboard />
  else if (pathname === '/cases' || pathname === '/search')
    general = <Directory kind="cases" key={pathname} />
  else if (pathname === '/profiles') general = <Directory kind="profiles" />
  else if (pathname === '/cases/new' && session.user.role !== 'VIEWER') general = <NewCase />
  else if (pathname === '/profiles/new' && session.user.role !== 'VIEWER') general = <NewProfile />
  else if (pathname === '/admin' && session.user.role === 'ADMIN') general = <Administration />
  else if (/^\/cases\/[0-9a-f-]{36}\/packet$/.test(pathname))
    general = <PacketPage caseId={pathname.split('/')[2]!} />
  else if (!active)
    general = (
      <Empty>
        Page unavailable. <Link to="/">Return to dashboard</Link>
      </Empty>
    )

  return (
    <NoticeContext.Provider value={notice}>
      <PendingContext.Provider value={updatePending}>
        <LiveContext.Provider value={{ revision, connected, refresh }}>
          <a className="skip-link" href="#workspace">
            Skip to workspace
          </a>
          <div className="app-shell">
            <aside className="rail">
              <Link className="brand" to="/">
                <span className="wordmark">C.R.A.S.H.</span>
                <span className="brand-sub">Investigation MDT</span>
              </Link>
              <nav className="main-nav" aria-label="Main navigation">
                <NavLink end to="/">
                  Dashboard
                </NavLink>
                <NavLink to="/cases">Cases</NavLink>
                <NavLink to="/profiles">Civilian profiles</NavLink>
                {session.user.role === 'ADMIN' && <NavLink to="/admin">Administration</NavLink>}
              </nav>
              <div className="rail-user">
                <strong>{session.user.displayName}</strong>
                <span>
                  {session.user.badge ? session.user.badge + ' · ' : ''}
                  {session.user.role.toLowerCase()}
                </span>
                {hasPending ? (
                  <Confirm
                    label="Sign out"
                    description="One or more documents have unsaved edits. Signing out will discard those edits."
                    run={signOut}
                  />
                ) : (
                  <AsyncButton run={signOut}>Sign out</AsyncButton>
                )}
              </div>
            </aside>
            <div className="shell-body">
              <header className="top-line">
                <Link to="/search">Global search</Link>
                <span
                  className={connected ? 'live-status online' : 'live-status offline'}
                  role="status"
                >
                  {connected ? 'Live updates' : 'Reconnecting'}
                </span>
              </header>
              <nav className="tabs" aria-label="Open records">
                <span className="tab-index">OPEN RECORDS</span>
                {tabs.length === 0 && <span className="tab-empty">No open records</span>}
                {tabs.map((tab) => {
                  const key = pathOf(tab)
                  const label =
                    labels[key] ||
                    (tab.kind === 'cases' ? 'Case' : tab.kind === 'profiles' ? 'Profile' : 'Document')
                  return (
                    <div className={'tab' + (activePath === key ? ' tab-active' : '')} key={key}>
                      <Link
                        to={key}
                        aria-current={activePath === key ? 'page' : undefined}
                        title={label}
                      >
                        {label}
                        {pending[key] && (
                          <span className="pending-mark" aria-label="Unsaved edits">
                            {' '}
                            •
                          </span>
                        )}
                      </Link>
                      {pending[key] ? (
                        <Confirm
                          label={'Discard edits and close ' + label}
                          description="Pending edits may be lost."
                          run={async () => close(tab)}
                        >
                          ×
                        </Confirm>
                      ) : (
                        <button
                          type="button"
                          className="tab-close"
                          aria-label={'Close ' + label}
                          onClick={() => close(tab)}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  )
                })}
              </nav>
              <main className="workspace" id="workspace" tabIndex={-1}>
                {general && (
                  <div className="workspace-panel" key={pathname}>
                    {general}
                  </div>
                )}
                {tabs.map((tab) => (
                  <div
                    className="workspace-panel"
                    key={pathOf(tab)}
                    hidden={activePath !== pathOf(tab)}
                  >
                    <OpenRecord tab={tab} rename={rename} />
                  </div>
                ))}
              </main>
              <div className="notice" role="status" aria-live="polite">
                {message && <span>{message}</span>}
              </div>
            </div>
          </div>
        </LiveContext.Provider>
      </PendingContext.Provider>
    </NoticeContext.Provider>
  )
}

function OpenRecord({ tab, rename }: { tab: Tab; rename: (key: string, name: string) => void }) {
  const key = pathOf(tab)
  const resource = useResource<CaseRecord | ProfileRecord | DocumentRecord>(key)
  const item = resource.value
  useEffect(() => {
    if (!item && resource.error) rename(key, 'Record unavailable')
    if (item)
      rename(
        key,
        'number' in item
          ? item.number + ' · ' + item.title
          : 'fullName' in item
            ? item.fullName
            : item.title,
      )
  }, [item, key, rename, resource.error])
  return (
    <ResourceView resource={resource}>
      {(record) =>
        'number' in record ? (
          <CasePage record={record} />
        ) : 'fullName' in record ? (
          <ProfilePage record={record} />
        ) : (
          <Suspense fallback={<Empty>Opening editor…</Empty>}>
            <DocumentPage record={record} tabKey={key} />
          </Suspense>
        )
      }
    </ResourceView>
  )
}

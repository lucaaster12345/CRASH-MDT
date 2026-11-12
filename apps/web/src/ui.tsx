import { useId, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react'
import { api, errorMessage, query } from './api.js'
import { useDate, useDebounce, useNotice, useResource, type Resource } from './state.js'
import type { Activity, CaseCard, Page, ProfileCard, RecordRef, User } from './types.js'
import { directImage, imageAllowed, safeHttps } from '../../../packages/shared/validation.js'

export function PageHead({
  title,
  kicker,
  detail,
  actions,
}: {
  title: string
  kicker?: ReactNode
  detail?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="page-head">
      <div className="heading-copy">
        {kicker && <div className="eyeline">{kicker}</div>}
        <h1>{title}</h1>
        {detail && <div className="head-detail">{detail}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  )
}

export function Field({
  label,
  children,
  hint,
  wide,
}: {
  label: string
  children: ReactNode
  hint?: string
  wide?: boolean
}) {
  return (
    <label className={'field' + (wide ? ' wide' : '')}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

export function MultilineInput(props: ComponentProps<'textarea'>) {
  return <textarea {...props} className={['resize-none', props.className].filter(Boolean).join(' ')} />
}

export function ActionForm({
  children,
  submit,
  label = 'Save changes',
  onCancel,
  className = '',
  success,
  focusCancel = false,
}: {
  children: ReactNode
  submit: (data: FormData) => Promise<unknown>
  label?: string
  onCancel?: () => void
  className?: string
  success?: string
  focusCancel?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const lock = useRef(false)
  const errorRef = useRef<HTMLDivElement>(null)
  const notice = useNotice()
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current) return
    const form = event.currentTarget
    const invalid = [...form.elements].find(
      (el) =>
        (el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement) &&
        !el.validity.valid,
    )
    if (invalid instanceof HTMLElement) {
      setFailure(
        (invalid.getAttribute('aria-label') ??
          invalid.closest('label')?.querySelector('span')?.textContent ??
          'Field') +
          ' · ' +
          (invalid as HTMLInputElement).validationMessage,
      )
      invalid.focus()
      return
    }
    lock.current = true
    setBusy(true)
    setFailure('')
    try {
      await submit(new FormData(form))
      if (success) notice(success)
    } catch (error) {
      setFailure(errorMessage(error))
      requestAnimationFrame(() => errorRef.current?.focus())
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <form noValidate onSubmit={send} className={className} aria-busy={busy}>
      <fieldset disabled={busy} className="form-body">
        {children}
      </fieldset>
      <div
        ref={errorRef}
        tabIndex={-1}
        role="alert"
        className={failure ? 'inline-error' : 'message-space'}
      >
        {failure}
      </div>
      <div className="actions">
        <button className="primary" disabled={busy} type="submit" aria-busy={busy}>
          {label}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-initial-focus={focusCancel || undefined}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

export function Confirm({
  label,
  description,
  run,
  danger = false,
  children,
}: {
  label: string
  description: string
  run: () => Promise<unknown>
  danger?: boolean
  children?: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  return (
    <>
      <button
        type="button"
        aria-label={children ? label : undefined}
        className={danger ? 'danger' : ''}
        onClick={() => {
          dialog.current?.showModal()
          dialog.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
        }}
      >
        {children || label}
      </button>
      <dialog ref={dialog} aria-labelledby={title}>
        <h2 id={title}>{label}</h2>
        <p>{description}</p>
        <ActionForm
          label={label}
          submit={async () => {
            await run()
            dialog.current?.close()
          }}
          onCancel={() => dialog.current?.close()}
          focusCancel
        >
          {null}
        </ActionForm>
      </dialog>
    </>
  )
}

export function AsyncButton({
  children,
  run,
  success,
  className,
}: {
  children: ReactNode
  run: () => Promise<unknown>
  success?: string
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  const notice = useNotice()
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      aria-busy={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await run()
          if (success) notice(success)
        } catch (error) {
          notice(errorMessage(error))
        } finally {
          setBusy(false)
        }
      }}
    >
      {children}
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}
export function ResourceView<T>({
  resource,
  children,
}: {
  resource: Resource<T>
  children: (value: T) => ReactNode
}) {
  return (
    <>
      {resource.error && (
        <div role="alert" className="inline-error">
          {resource.error}{' '}
          <button type="button" className="text-button" onClick={resource.retry}>
            Retry
          </button>
        </div>
      )}
      {resource.loading && (
        <div className="empty" role="status">
          Loading…
        </div>
      )}
      {resource.value !== null && children(resource.value)}
    </>
  )
}
export function Table({
  headings,
  children,
  name,
}: {
  headings: string[]
  children: ReactNode
  name: string
}) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={name}>
      <table>
        <thead>
          <tr>
            {headings.map((heading, index) => (
              <th key={index} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
export function Pager({
  page,
  more,
  setPage,
}: {
  page: number
  more: boolean
  setPage: (page: number) => void
}) {
  return (
    <nav aria-label="Pages" className="pager">
      <button onClick={() => setPage(page - 1)} disabled={page <= 1}>
        Previous
      </button>
      <span aria-live="polite">Page {page}</span>
      <button onClick={() => setPage(page + 1)} disabled={!more}>
        Next
      </button>
    </nav>
  )
}

export function SelectOptions({ values }: { values: readonly { id: string; label: string }[] }) {
  return (
    <>
      {values.map((item) => (
        <option key={item.id} value={item.id}>
          {item.label}
        </option>
      ))}
    </>
  )
}

type LookupKind = 'officers' | 'profiles' | 'cases'
export function Lookup({
  label,
  name,
  kind,
  initial = [],
  multiple = false,
  onSelect,
}: {
  label: string
  name: string
  kind: LookupKind
  initial?: RecordRef[]
  multiple?: boolean
  onSelect?: (item: RecordRef | null) => void
}) {
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState(initial)
  const [composing, setComposing] = useState(false)
  const settled = useDebounce(composing ? '' : filter)
  const lookup = useResource<Page<User | ProfileCard | CaseCard>>(
    settled.trim() ? '/search/' + kind + query({ q: settled }) : null,
  )
  function select(item: RecordRef) {
    setPicked((current) => (multiple ? [...current, item] : [item]))
    onSelect?.(item)
    setFilter('')
  }
  function remove(item: RecordRef) {
    setPicked(picked.filter((other) => other.id !== item.id))
    if (!multiple) onSelect?.(null)
  }
  return (
    <div className="lookup">
      <Field label={label}>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault()
          }}
          placeholder={
            picked.length && !multiple ? 'Search to replace' : 'Search by name or identifier'
          }
        />
      </Field>
      {!!picked.length && (
        <ul className="selection">
          {picked.map((item) => (
            <li key={item.id}>
              <input type="hidden" name={name} value={item.id} />
              {item.label}
              <button
                type="button"
                className="text-button"
                aria-label={'Remove ' + item.label}
                onClick={() => remove(item)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {filter.trim() && (
        <ResourceView resource={lookup}>
          {(result) => {
            const choices = result.items
              .map((item) => ({
                id: item.id,
                label:
                  'displayName' in item
                    ? item.displayName + (item.badge ? ' · ' + item.badge : '')
                    : 'fullName' in item
                      ? item.fullName + (item.identifier ? ' · ' + item.identifier : '')
                      : item.number + ' · ' + item.title,
              }))
              .filter((item) => !picked.some((selected) => selected.id === item.id))
            return choices.length ? (
              <ul className="lookup-results" aria-label={label + ' results'}>
                {choices.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => select(item)}>
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No matching records.</p>
            )
          }}
        </ResourceView>
      )}
    </div>
  )
}

export function RemoteImage({
  url,
  caption,
  hosts,
  eager = false,
}: {
  url: string
  caption: string
  hosts: string[]
  eager?: boolean
}) {
  const [failed, setFailed] = useState('')
  const inline = url !== failed && imageAllowed(url, hosts) && directImage(url)
  return (
    <figure className="remote-image">
      {inline ? (
        <img
          src={url}
          alt={caption}
          loading={eager ? 'eager' : 'lazy'}
          referrerPolicy="no-referrer"
          onError={() => setFailed(url)}
        />
      ) : (
        <div className="image-fallback">
          {url === failed
            ? 'Image unavailable or expired.'
            : 'Preview unavailable. Use a direct image URL from an approved host for inline display.'}
        </div>
      )}
      <figcaption>
        <span>{caption}</span>
        {safeHttps(url) && (
          <a href={url} target="_blank" rel="noreferrer noopener">
            Open original
          </a>
        )}
      </figcaption>
    </figure>
  )
}

export function Events({ entries, details = false }: { entries: Activity[]; details?: boolean }) {
  const date = useDate()
  if (!entries.length) return <Empty>No recorded changes.</Empty>
  return (
    <ol className="events">
      {entries.map((entry) => (
        <li key={entry.id}>
          <time dateTime={entry.createdAt}>{date(entry.createdAt)}</time>
          <div>
            <strong>{entry.action.replaceAll('.', ' · ').replaceAll('_', ' ')}</strong>
            <span className="muted"> · {entry.actor?.displayName ?? 'System'}</span>
            {details && entry.details != null && (
              <details>
                <summary>Change details</summary>
                <pre>{JSON.stringify(entry.details, null, 2)}</pre>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

export function remove(path: string, data: unknown) {
  return api(path, { method: 'DELETE', data })
}

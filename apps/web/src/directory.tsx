import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, query, string } from './api.js'
import { useCatalog, useDate, useDebounce, useResource, useSession } from './state.js'
import {
  AsyncButton,
  Empty,
  Field,
  ActionForm,
  Lookup,
  PageHead,
  Pager,
  ResourceView,
  SelectOptions,
  Table,
} from './ui.js'
import type { CaseCard, DashboardData, Page, ProfileCard, RecordRef, TaskCard } from './types.js'
import { labels, priorities, searchFilters } from '../../../packages/shared/validation.js'

function CaseTable({
  items,
  empty = 'No cases found.',
  compact = false,
}: {
  items: CaseCard[]
  empty?: string
  compact?: boolean
}) {
  const date = useDate()
  if (!items.length) return <Empty>{empty}</Empty>
  return (
    <Table
      name="Case records"
      headings={
        compact
          ? ['Case', 'Status', 'Updated']
          : ['Case', 'Status', 'Priority', 'Lead investigator', 'Updated']
      }
    >
      {items.map((item) => (
        <tr key={item.id}>
          <td>
            <Link className="record-title" to={'/cases/' + item.id}>
              <span className="record-code">{item.number}</span>
              {item.title}
            </Link>
            <span className="minor">
              {[
                item.restricted && 'Restricted',
                item.exact && 'Exact case number',
                compact && labels[item.priority] + ' priority',
                ...item.tags.map((x) => x.tag.label),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </td>
          <td>
            <span className={'state state-' + item.status.id}>{item.status.label}</span>
          </td>
          {!compact && (
            <td className={'priority-' + item.priority.toLowerCase()}>{labels[item.priority]}</td>
          )}
          {!compact && <td>{item.lead?.displayName ?? 'Unassigned'}</td>}
          <td className="date-cell">{date(item.updatedAt)}</td>
        </tr>
      ))}
    </Table>
  )
}

function ProfileTable({ items }: { items: ProfileCard[] }) {
  if (!items.length) return <Empty>No matching civilian profiles.</Empty>
  return (
    <Table name="Civilian profile records" headings={['Name', 'Aliases', 'Identifier', 'Status']}>
      {items.map((item) => (
        <tr key={item.id}>
          <td>
            <Link to={'/profiles/' + item.id}>{item.fullName}</Link>
          </td>
          <td>{item.aliases.join(', ') || '—'}</td>
          <td>
            <span className="record-code">{item.identifier ?? '—'}</span>
            {item.exact && <span className="minor">Exact identifier</span>}
          </td>
          <td>{item.archivedAt ? 'Archived' : 'Current'}</td>
        </tr>
      ))}
    </Table>
  )
}

function TaskTable({ items, empty }: { items: TaskCard[]; empty: string }) {
  const date = useDate()
  if (!items.length) return <Empty>{empty}</Empty>
  return (
    <Table name="Assigned tasks" headings={['Task', 'Case', 'Status', 'Due']}>
      {items.map((item) => (
        <tr key={item.id}>
          <td>{item.description}</td>
          <td>
            <Link to={'/cases/' + item.case.id}>
              <span className="record-code">{item.case.number}</span>
              {item.case.title}
            </Link>
          </td>
          <td>{labels[item.status]}</td>
          <td className="date-cell">
            {date(item.dueAt)}
            {item.dueAt && new Date(item.dueAt) < new Date() && (
              <span className="minor overdue">Overdue</span>
            )}
          </td>
        </tr>
      ))}
    </Table>
  )
}

export function Dashboard() {
  const resource = useResource<DashboardData>('/search/dashboard')
  const { user, timezone } = useSession()
  return (
    <div className="page">
      <PageHead
        title="Dashboard"
        detail={'Times shown in ' + timezone}
        actions={
          user.role !== 'VIEWER' && (
            <Link className="button primary" to="/cases/new">
              New case
            </Link>
          )
        }
      />
      <ResourceView resource={resource}>
        {(data) => (
          <div className="desk-grid">
            <section className="surface">
              <h2>My cases</h2>
              <CaseTable compact items={data.myCases} empty="You have no assigned cases." />
            </section>
            <section className="surface">
              <h2>My tasks</h2>
              <TaskTable items={data.myTasks} empty="You have no open tasks." />
            </section>
            <section className="surface">
              <h2>Recently updated</h2>
              <CaseTable compact items={data.recent} empty="No recent case activity." />
            </section>
            <section className="surface">
              <h2>Overdue follow-ups</h2>
              <TaskTable items={data.overdue} empty="You have no overdue follow-ups." />
            </section>
            <section className="surface">
              <h2>Pinned cases</h2>
              <CaseTable compact items={data.pinned} empty="Pin a case to keep it here." />
            </section>
            <section className="surface">
              <h2>Saved searches</h2>
              {data.saved.length ? (
                <ul className="line-list">
                  {data.saved.map((search) => (
                    <li key={search.id}>
                      <Link to={'/cases' + query(search.filters)}>{search.label}</Link>
                      <AsyncButton
                        className="text-button"
                        run={() => api('/search/saved/' + search.id, { method: 'DELETE' })}
                        success="Saved search removed."
                      >
                        Remove
                      </AsyncButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No saved searches.</Empty>
              )}
            </section>
          </div>
        )}
      </ResourceView>
    </div>
  )
}

export function Directory({ kind }: { kind: 'cases' | 'profiles' }) {
  const [params, setParams] = useSearchParams()
  const [composing, setComposing] = useState(false)
  const [save, setSave] = useState(false)
  const [selectedOfficer, setOfficer] = useState<RecordRef | null>(null)
  const value = params.get('q') ?? ''
  const settled = useDebounce(value)
  const parsed = searchFilters.safeParse(Object.fromEntries(params))
  const filters = parsed.success ? parsed.data : searchFilters.parse({})
  const page = filters.page
  const global = location.pathname === '/search'
  const { user } = useSession()
  const catalog = useCatalog()
  const url = '/search/' + kind + query({ ...filters, q: settled })
  const result = useResource<Page<CaseCard> | Page<ProfileCard>>(composing ? null : url)
  const profiles = useResource<Page<ProfileCard>>(
    global && settled && !composing
      ? '/search/profiles' +
          query({ q: settled, archived: filters.archived, page: params.get('profilesPage') })
      : null,
  )
  const profilePage = Math.max(1, Number(params.get('profilesPage')) || 1)

  function update(name: string, value: string, replace = false) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    if (name !== 'page' && name !== 'profilesPage') {
      next.delete('page')
      next.delete('profilesPage')
    }
    setParams(next, { replace, preventScrollReset: true })
  }
  function submit(event: FormEvent) {
    event.preventDefault()
  }

  return (
    <div className="page">
      <PageHead
        title={global ? 'Global search' : kind === 'cases' ? 'Cases' : 'Civilian profiles'}
        actions={
          user.role !== 'VIEWER' && (
            <Link className="button primary" to={'/' + kind + '/new'}>
              {kind === 'cases' ? 'New case' : 'New profile'}
            </Link>
          )
        }
      />
      <form className="filter-block" noValidate onSubmit={submit}>
        <div className="filter-main">
          <Field label={kind === 'cases' ? 'Search records' : 'Search civilian profiles'}>
            <input
              type="search"
              value={value}
              onChange={(e) => update('q', e.target.value, true)}
              maxLength={160}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              placeholder={
                kind === 'cases'
                  ? 'Case number, title, person or report text'
                  : 'Name, alias or identifier'
              }
            />
          </Field>
          <Field label="Archive">
            <select value={filters.archived ?? ''} onChange={(e) => update('archived', e.target.value)}>
              <option value="">Current only</option>
              <option value="include">Include archived</option>
              <option value="only">Archived only</option>
            </select>
          </Field>
          <button
            type="button"
            onClick={() => {
              setOfficer(null)
              setParams({})
            }}
            disabled={!params.size}
          >
            Clear filters
          </button>
          {kind === 'cases' && (
            <button type="button" onClick={() => setSave(!save)} aria-expanded={save}>
              Save search
            </button>
          )}
        </div>
        {kind === 'cases' && (
          <div className="filter-detail">
            <Field label="Status">
              <select value={filters.status ?? ''} onChange={(e) => update('status', e.target.value)}>
                <option value="">All statuses</option>
                <SelectOptions values={catalog.value?.statuses ?? []} />
              </select>
            </Field>
            <Field label="Priority">
              <select
                value={filters.priority ?? ''}
                onChange={(e) => update('priority', e.target.value)}
              >
                <option value="">All priorities</option>
                {priorities.map((value) => (
                  <option key={value} value={value}>
                    {labels[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tag">
              <select value={filters.tagId ?? ''} onChange={(e) => update('tagId', e.target.value)}>
                <option value="">All tags</option>
                <SelectOptions values={catalog.value?.tags ?? []} />
              </select>
            </Field>
            <Field label="From (UTC)">
              <input
                type="date"
                value={filters.from ?? ''}
                onChange={(e) => update('from', e.target.value)}
              />
            </Field>
            <Field label="Through (UTC)">
              <input
                type="date"
                value={filters.to ?? ''}
                onChange={(e) => update('to', e.target.value)}
              />
            </Field>
            <Lookup
              key={filters.investigator ?? 'all'}
              name="investigator"
              label="Assigned investigator"
              kind="officers"
              initial={
                filters.investigator
                  ? [
                      selectedOfficer?.id === filters.investigator
                        ? selectedOfficer
                        : { id: filters.investigator, label: 'Saved investigator' },
                    ]
                  : []
              }
              onSelect={(officer) => {
                setOfficer(officer)
                update('investigator', officer?.id ?? '')
              }}
            />
          </div>
        )}
      </form>
      {save && (
        <div className="edit-block">
          <ActionForm
            label="Save search"
            onCancel={() => setSave(false)}
            success="Search saved."
            submit={async (form) => {
              await api('/search/saved', {
                method: 'POST',
                data: { label: string(form, 'label'), filters },
              })
              setSave(false)
            }}
          >
            <Field label="Search name">
              <input required name="label" maxLength={80} />
            </Field>
          </ActionForm>
        </div>
      )}
      <section className="surface">
        <h2>{kind === 'cases' ? 'Case results' : 'Profile results'}</h2>
        <ResourceView resource={result}>
          {(data) => (
            <>
              {kind === 'cases' ? (
                <CaseTable items={data.items as CaseCard[]} />
              ) : (
                <ProfileTable items={data.items as ProfileCard[]} />
              )}
              <Pager page={page} more={data.more} setPage={(next) => update('page', String(next))} />
            </>
          )}
        </ResourceView>
      </section>
      {global && settled && (
        <section className="surface">
          <h2>Matching civilian profiles</h2>
          <ResourceView resource={profiles}>
            {(data) => (
              <>
                <ProfileTable items={data.items} />
                <Pager
                  page={profilePage}
                  more={data.more}
                  setPage={(next) => update('profilesPage', String(next))}
                />
              </>
            )}
          </ResourceView>
        </section>
      )}
    </div>
  )
}

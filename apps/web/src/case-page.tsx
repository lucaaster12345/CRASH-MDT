import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, instant, nullable, selected, string, timeValue } from './api.js'
import { useCatalog, useDate, useNotice, useResource, useSession } from './state.js'
import {
  MultilineInput,
  AsyncButton,
  Confirm,
  Empty,
  Events,
  Field,
  ActionForm,
  Lookup,
  PageHead,
  Pager,
  ResourceView,
  SelectOptions,
  remove,
} from './ui.js'
import {
  documentTypes,
  labels,
  personRoles,
  priorities,
  safeHttps,
} from '../../../packages/shared/validation.js'
import type { Activity, CaseRecord, Page, User } from './types.js'
import { EvidenceSection, TasksSection } from './case-items.js'

export const officer = (user: User | null) =>
  user ? [{ id: user.id, label: user.displayName + (user.badge ? ' · ' + user.badge : '') }] : []
const sections = ['Overview', 'People', 'Documents', 'Evidence', 'Tasks', 'Activity'] as const
type Section = (typeof sections)[number]

function caseInput(form: FormData) {
  return {
    title: string(form, 'title'),
    summary: string(form, 'summary'),
    priority: string(form, 'priority'),
    occurredAt: instant(form, 'occurredAt'),
    restricted: form.has('restricted'),
    leadId: nullable(form, 'leadId'),
    memberIds: selected(form, 'memberIds'),
    tagIds: selected(form, 'tagIds'),
  }
}
function CaseFields({ record }: { record?: CaseRecord }) {
  const catalog = useCatalog()
  return (
    <div className="form-grid">
      <Field label="Case title" wide>
        <input required name="title" maxLength={180} defaultValue={record?.title} />
      </Field>
      <Field label="Summary" wide>
        <MultilineInput name="summary" rows={4} maxLength={12000} defaultValue={record?.summary} />
      </Field>
      <Field label="Priority">
        <select name="priority" defaultValue={record?.priority ?? 'NORMAL'}>
          {priorities.map((item) => (
            <option key={item} value={item}>
              {labels[item]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Incident date and time (UTC)">
        <input type="datetime-local" name="occurredAt" defaultValue={timeValue(record?.occurredAt)} />
      </Field>
      <Lookup
        name="leadId"
        label="Lead investigator"
        kind="officers"
        initial={officer(record?.lead ?? null)}
      />
      <Lookup
        name="memberIds"
        label="Assigned officers"
        kind="officers"
        initial={record?.members.flatMap((item) => officer(item.user))}
        multiple
      />
      <Field label="Tags" hint="Use Ctrl or Command to choose multiple tags.">
        <select
          name="tagIds"
          multiple
          defaultValue={record?.tags.map((item) => item.tagId) ?? []}
          size={Math.min(5, Math.max(2, catalog.value?.tags.length ?? 0))}
        >
          <SelectOptions values={catalog.value?.tags ?? record?.tags.map((item) => item.tag) ?? []} />
        </select>
      </Field>
      <div className="check-group">
        <label className="check">
          <input type="checkbox" name="restricted" defaultChecked={record?.restricted} />
          Restricted case
        </label>
        <small>Only the lead, assigned members and administrators can open a restricted case.</small>
        {!record && (
          <label className="check">
            <input type="checkbox" name="template" defaultChecked />
            Start the main incident report with headings
          </label>
        )}
      </div>
    </div>
  )
}
export function NewCase() {
  const navigate = useNavigate()
  return (
    <div className="page reading">
      <PageHead title="New case" detail="A main incident report is created with every draft." />
      <section className="surface padded">
        <ActionForm
          label="Create case"
          onCancel={() => navigate('/cases')}
          success="Draft case created."
          submit={async (form) => {
            const record = await api<{ id: string }>('/cases', {
              method: 'POST',
              data: { ...caseInput(form), template: form.has('template') },
            })
            navigate('/cases/' + record.id)
          }}
        >
          <CaseFields />
        </ActionForm>
      </section>
    </div>
  )
}

function casePath(record: CaseRecord) {
  return '/cases/' + record.id
}

function StatusControls({ record }: { record: CaseRecord }) {
  const { user } = useSession()
  const catalog = useCatalog()
  const notice = useNotice()
  if (user.role === 'VIEWER') return null
  const transition = async (action: string, status?: string) => {
    await api(casePath(record) + '/status', {
      method: 'POST',
      data: { action, status, version: record.version },
    })
    notice('Case status updated.')
  }
  if (record.statusId === 'archived')
    return (
      <Confirm
        label="Restore case"
        description="Return this case to its status before archiving."
        run={() => transition('restore')}
      />
    )
  return (
    <div className="status-actions">
      {record.statusId === 'closed' ? (
        <Confirm
          label="Reopen case"
          description="Return this closed case to Active and allow edits."
          run={() => transition('reopen')}
        />
      ) : (
        <ActionForm
          label="Update status"
          submit={(data) => transition('move', string(data, 'status'))}
          className="compact-form"
        >
          <Field label="Change status">
            <select name="status" defaultValue={record.statusId} key={record.statusId}>
              <SelectOptions
                values={
                  catalog.value?.statuses.filter((status) => status.id !== 'archived') ?? [
                    record.status,
                  ]
                }
              />
            </select>
          </Field>
        </ActionForm>
      )}
      <Confirm
        label="Archive case"
        description="Make this case read-only and move it into archive search."
        run={() => transition('archive')}
      />
    </div>
  )
}

function Overview({ record }: { record: CaseRecord }) {
  const [editing, setEditing] = useState<CaseRecord | null>(null)
  const date = useDate()
  const report = record.documents.find((doc) => doc.type === 'INCIDENT')
  return (
    <>
      {record.statusId === 'draft' && (
        <p className="callout">Submit the incident report before moving this case out of Draft.</p>
      )}
      <div className="record-grid">
        <section className="surface padded">
          <div className="section-head">
            <h2>Case summary</h2>
            {record.writable && !editing && (
              <button onClick={() => setEditing(record)}>Edit case</button>
            )}
          </div>
          {editing && record.writable ? (
            <ActionForm
              onCancel={() => setEditing(null)}
              success="Case details saved."
              submit={async (form) => {
                await api(casePath(record), {
                  method: 'PATCH',
                  data: { ...caseInput(form), version: editing.version },
                })
                setEditing(null)
              }}
            >
              <CaseFields record={editing} />
            </ActionForm>
          ) : (
            <>
              <p className="prose preserve">{record.summary || 'No case summary has been entered.'}</p>
              {!!record.tags.length && (
                <ul className="tags">
                  {record.tags.map(({ tag }) => (
                    <li key={tag.id}>{tag.label}</li>
                  ))}
                </ul>
              )}
              {report && (
                <div className="report-entry">
                  <span className="eyeline">REQUIRED DOCUMENT</span>
                  <Link to={'/documents/' + report.id}>{report.title}</Link>
                  <span className="muted">
                    {!report.submitted
                      ? 'Working draft'
                      : report.stateHash === report.submitted.stateHash
                        ? 'Submitted ' + date(report.submitted.createdAt)
                        : 'Amended · pending review'}
                  </span>
                </div>
              )}
            </>
          )}
        </section>
        <section className="surface padded">
          <h2>Case details</h2>
          <dl className="facts">
            <dt>Lead investigator</dt>
            <dd>{record.lead?.displayName ?? 'Unassigned'}</dd>
            <dt>Assigned officers</dt>
            <dd>{record.members.map((item) => item.user.displayName).join(', ') || 'None'}</dd>
            <dt>Access</dt>
            <dd>{record.restricted ? 'Restricted' : 'Unit members'}</dd>
            <dt>Incident date</dt>
            <dd>{date(record.occurredAt)}</dd>
            <dt>Opened</dt>
            <dd>{date(record.openedAt)}</dd>
            {record.closedAt && (
              <>
                <dt>Closed</dt>
                <dd>{date(record.closedAt)}</dd>
              </>
            )}
            {record.archivedAt && (
              <>
                <dt>Archived</dt>
                <dd>{date(record.archivedAt)}</dd>
              </>
            )}
          </dl>
          <StatusControls record={record} />
        </section>
      </div>
      <RelatedCases record={record} />
    </>
  )
}

function RelatedCases({ record }: { record: CaseRecord }) {
  const [draft, setDraft] = useState<{
    version: number
    to?: { id: string; label: string }
    explanation?: string
  } | null>(null)
  return (
    <section className="surface padded">
      <div className="section-head">
        <h2>Related cases</h2>
        {record.writable && !draft && (
          <button onClick={() => setDraft({ version: record.version })}>Link case</button>
        )}
      </div>
      {draft && record.writable && (
        <ActionForm
          className="edit-block"
          label="Save case link"
          onCancel={() => setDraft(null)}
          success="Related case link saved."
          submit={async (form) => {
            await api(casePath(record) + '/related', {
              method: 'POST',
              data: {
                toId: nullable(form, 'toId'),
                explanation: string(form, 'explanation'),
                version: draft.version,
              },
            })
            setDraft(null)
          }}
        >
          <Lookup name="toId" label="Related case" kind="cases" initial={draft.to ? [draft.to] : []} />
          <Field label="Connection">
            <MultilineInput
              required
              name="explanation"
              rows={2}
              maxLength={1000}
              defaultValue={draft.explanation}
            />
          </Field>
        </ActionForm>
      )}
      {record.links.length ? (
        <ul className="line-list">
          {record.links.map(({ to, explanation }) => (
            <li key={to.id}>
              <div>
                <Link to={'/cases/' + to.id}>
                  {to.number} · {to.title}
                </Link>
                <p className="preserve muted">{explanation}</p>
              </div>
              {record.writable && (
                <div className="actions">
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        version: record.version,
                        to: { id: to.id, label: to.number + ' · ' + to.title },
                        explanation,
                      })
                    }
                  >
                    Edit link
                  </button>
                  <Confirm
                    label="Remove link"
                    description={'Remove the connection to ' + to.number + '.'}
                    run={() =>
                      remove(casePath(record) + '/related/' + to.id, { version: record.version })
                    }
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No related cases are visible.</Empty>
      )}
    </section>
  )
}

type Person = CaseRecord['persons'][number]
function People({ record }: { record: CaseRecord }) {
  const [draft, setDraft] = useState<{ role: Person['role']; person?: Person; version: number } | null>(
    null,
  )
  const navigate = useNavigate()
  return (
    <>
      {personRoles.map((role) => (
        <section className="surface padded" key={role}>
          <div className="section-head">
            <h2>{labels[role]}</h2>
            {record.writable && (
              <button onClick={() => setDraft({ role, version: record.version })}>
                Add{' '}
                {role === 'SUSPECT'
                  ? 'suspect'
                  : role === 'OFFICER'
                    ? 'officer'
                    : 'civilian or witness'}
              </button>
            )}
          </div>
          {draft?.role === role && record.writable && (
            <ActionForm
              label={draft.person ? 'Save person' : 'Add person'}
              onCancel={() => setDraft(null)}
              key={draft.person?.id ?? role}
              className="edit-block"
              success="Person saved."
              submit={async (form) => {
                await api(casePath(record) + '/persons' + (draft.person ? '/' + draft.person.id : ''), {
                  method: draft.person ? 'PATCH' : 'POST',
                  data: {
                    role,
                    name: string(form, 'name'),
                    detail: string(form, 'detail'),
                    userId: nullable(form, 'userId'),
                    profileId: nullable(form, 'profileId'),
                    version: draft.version,
                  },
                })
                setDraft(null)
              }}
            >
              <div className="form-grid">
                <Field label="Name as recorded">
                  <input name="name" required maxLength={180} defaultValue={draft.person?.name} />
                </Field>
                {role === 'OFFICER' ? (
                  <Lookup
                    label="Link officer account"
                    name="userId"
                    kind="officers"
                    initial={officer(draft.person?.user ?? null)}
                  />
                ) : (
                  <Lookup
                    label="Link existing civilian profile"
                    name="profileId"
                    kind="profiles"
                    initial={
                      draft.person?.profile
                        ? [{ id: draft.person.profile.id, label: draft.person.profile.fullName }]
                        : []
                    }
                  />
                )}
                <Field label="Role or case-specific details" wide>
                  <MultilineInput
                    name="detail"
                    rows={3}
                    maxLength={4000}
                    defaultValue={draft.person?.detail}
                  />
                </Field>
              </div>
            </ActionForm>
          )}
          {record.persons.some((person) => person.role === role) ? (
            <ul className="line-list">
              {record.persons
                .filter((person) => person.role === role)
                .map((person) => (
                  <li key={person.id}>
                    <div>
                      <strong>{person.name}</strong>
                      {person.profile && (
                        <p>
                          <Link to={'/profiles/' + person.profile.id}>{person.profile.fullName}</Link>
                          {person.profile.archivedAt && ' · Archived profile'}
                        </p>
                      )}
                      {person.user && <p className="muted">{officer(person.user)[0]?.label}</p>}
                      {person.detail && <p className="preserve">{person.detail}</p>}
                    </div>
                    {record.writable && (
                      <div className="actions">
                        {role !== 'OFFICER' && !person.profile && (
                          <Confirm
                            label="Create civilian profile"
                            description={
                              'Create and link a profile for ' +
                              person.name +
                              '. Use Edit person to check for existing profiles first.'
                            }
                            run={async () => {
                              const result = await api<{ id: string }>(
                                casePath(record) + '/persons/' + person.id + '/profile',
                                {
                                  method: 'POST',
                                  data: { version: record.version },
                                },
                              )
                              navigate('/profiles/' + result.id)
                            }}
                          />
                        )}
                        <button onClick={() => setDraft({ role, person, version: record.version })}>
                          Edit person
                        </button>
                        <Confirm
                          label="Remove person"
                          description={'Remove ' + person.name + ' from this case.'}
                          run={() =>
                            remove(casePath(record) + '/persons/' + person.id, {
                              version: record.version,
                            })
                          }
                        />
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          ) : (
            <Empty>No {labels[role].toLowerCase()} recorded.</Empty>
          )}
        </section>
      ))}
    </>
  )
}

function Documents({ record }: { record: CaseRecord }) {
  const [adding, setAdding] = useState(false)
  const [linking, setLinking] = useState<number | null>(null)
  const navigate = useNavigate()
  const date = useDate()
  const report = record.documents.find((doc) => doc.type === 'INCIDENT')
  const docs = record.documents.filter((doc) => doc.type !== 'INCIDENT')
  const categories = [...new Set(docs.map((doc) => doc.category))].sort()
  return (
    <>
      <section className="surface padded">
        <h2>Main incident report</h2>
        {report && (
          <div className="line-row">
            <Link to={'/documents/' + report.id}>{report.title}</Link>
            <span className="muted">
              {report.submitted
                ? report.submitted.stateHash === report.stateHash
                  ? 'Submitted ' + date(report.submitted.createdAt)
                  : 'Amended · pending review'
                : 'Working draft'}
            </span>
          </div>
        )}
      </section>
      <section className="surface padded">
        <div className="section-head">
          <h2>Supporting documents</h2>
          {record.writable && !adding && <button onClick={() => setAdding(true)}>New document</button>}
        </div>
        {record.writable && adding && (
          <ActionForm
            label="Create document"
            onCancel={() => setAdding(false)}
            success="Document created."
            className="edit-block"
            submit={async (form) => {
              const doc = await api<{ id: string }>('/documents/case/' + record.id, {
                method: 'POST',
                data: {
                  title: string(form, 'title'),
                  category: string(form, 'category'),
                  type: string(form, 'type'),
                  template: form.has('template'),
                },
              })
              setAdding(false)
              navigate('/documents/' + doc.id)
            }}
          >
            <div className="form-grid">
              <Field label="Document title" wide>
                <input required name="title" maxLength={180} />
              </Field>
              <Field label="Document type">
                <select name="type" defaultValue="NOTES">
                  {documentTypes
                    .filter((type) => type !== 'INCIDENT')
                    .map((type) => (
                      <option value={type} key={type}>
                        {labels[type]}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Category">
                <input name="category" maxLength={100} />
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" name="template" defaultChecked />
              Start with template headings
            </label>
          </ActionForm>
        )}
        {categories.length ? (
          categories.map((category) => (
            <div key={category}>
              <h3>{category || 'Uncategorized'}</h3>
              <ul className="line-list">
                {docs
                  .filter((doc) => doc.category === category)
                  .map((doc) => (
                    <li key={doc.id}>
                      <div>
                        <Link to={'/documents/' + doc.id}>{doc.title}</Link>
                        <span className="minor">
                          {labels[doc.type]} · {doc.author.displayName}
                        </span>
                      </div>
                      <time>{date(doc.updatedAt)}</time>
                    </li>
                  ))}
              </ul>
            </div>
          ))
        ) : (
          <Empty>No supporting documents.</Empty>
        )}
      </section>
      <section className="surface padded">
        <div className="section-head">
          <h2>External document links</h2>
          {record.writable && linking === null && (
            <button onClick={() => setLinking(record.version)}>Add link</button>
          )}
        </div>
        {record.writable && linking !== null && (
          <ActionForm
            label="Add link"
            onCancel={() => setLinking(null)}
            success="External link added."
            className="edit-block"
            submit={async (form) => {
              await api(casePath(record) + '/external-links', {
                method: 'POST',
                data: {
                  title: string(form, 'title'),
                  description: string(form, 'description'),
                  url: string(form, 'url'),
                  version: linking,
                },
              })
              setLinking(null)
            }}
          >
            <div className="form-grid">
              <Field label="Link title">
                <input required name="title" maxLength={180} />
              </Field>
              <Field label="HTTPS URL">
                <input type="url" required name="url" />
              </Field>
              <Field label="Description" wide>
                <MultilineInput name="description" rows={2} maxLength={1500} />
              </Field>
            </div>
          </ActionForm>
        )}
        {record.externalLinks.length ? (
          <ul className="line-list">
            {record.externalLinks.map((item) => (
              <li key={item.id}>
                <div>
                  {safeHttps(item.url) && (
                    <a href={item.url} target="_blank" rel="noreferrer noopener">
                      {item.title}
                    </a>
                  )}
                  <p className="preserve muted">{item.description}</p>
                </div>
                {record.writable && (
                  <Confirm
                    label="Remove link"
                    description={'Remove the external link named ' + item.title + '.'}
                    run={() =>
                      remove(casePath(record) + '/external-links/' + item.id, {
                        version: record.version,
                      })
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No external document links.</Empty>
        )}
      </section>
    </>
  )
}

function CaseActivity({ record }: { record: CaseRecord }) {
  const [page, setPage] = useState(1)
  const activity = useResource<Page<Activity>>(casePath(record) + '/activity?page=' + page)
  return (
    <section className="surface padded">
      <h2>Case timeline</h2>
      <ResourceView resource={activity}>
        {(data) => (
          <>
            <Events entries={data.items} />
            <Pager page={page} setPage={setPage} more={data.more} />
          </>
        )}
      </ResourceView>
    </section>
  )
}

export function CasePage({ record }: { record: CaseRecord }) {
  const [section, setSection] = useState<Section>('Overview')
  const date = useDate()
  const pinned = record.favorites.length > 0
  return (
    <div className="page">
      <Link className="crumb" to="/cases">
        Cases
      </Link>
      <PageHead
        title={record.title}
        kicker={<span className="record-code">{record.number}</span>}
        detail={
          <>
            <span className={'state state-' + record.statusId}>{record.status.label}</span>
            <span className={'priority-' + record.priority.toLowerCase()}>
              {labels[record.priority]} priority
            </span>
            {record.restricted && <span>Restricted</span>}
            {!record.writable && <span>Read-only</span>}
            <span>Updated {date(record.updatedAt)}</span>
          </>
        }
        actions={
          <>
            <AsyncButton
              run={() =>
                api('/search/favorites/' + record.id, { method: 'PUT', data: { pinned: !pinned } })
              }
              success={pinned ? 'Case unpinned.' : 'Case pinned.'}
            >
              {pinned ? 'Unpin case' : 'Pin case'}
            </AsyncButton>
            <Link className="button" to={casePath(record) + '/packet'}>
              Case packet
            </Link>
          </>
        }
      />
      <nav className="section-nav" aria-label="Case sections">
        {sections.map((item) => (
          <button
            type="button"
            aria-pressed={section === item}
            key={item}
            onClick={() => setSection(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {section === 'Overview' && <Overview record={record} />}
      {section === 'People' && <People record={record} />}
      {section === 'Documents' && <Documents record={record} />}
      {section === 'Evidence' && <EvidenceSection record={record} />}
      {section === 'Tasks' && <TasksSection record={record} />}
      {section === 'Activity' && <CaseActivity record={record} />}
    </div>
  )
}

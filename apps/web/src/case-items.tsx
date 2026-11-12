import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, instant, nullable, string, timeValue } from './api.js'
import { useCatalog, useDate, useResource } from './state.js'
import {
  MultilineInput,
  Confirm,
  Empty,
  Events,
  Field,
  ActionForm,
  Lookup,
  Pager,
  RemoteImage,
  ResourceView,
  SelectOptions,
  Table,
  remove,
} from './ui.js'
import {
  evidenceTypes,
  labels,
  priorities,
  safeHttps,
  taskStatuses,
} from '../../../packages/shared/validation.js'
import type { Activity, CaseRecord, Page } from './types.js'

type Evidence = CaseRecord['evidence'][number]
type Task = CaseRecord['tasks'][number]
const route = (record: CaseRecord) => '/cases/' + record.id

function EvidenceForm({
  record,
  initial,
  close,
}: {
  record: CaseRecord
  initial: Evidence | null
  close: () => void
}) {
  const catalog = useCatalog()
  return (
    <ActionForm
      label={initial ? 'Save evidence' : 'Add evidence'}
      onCancel={close}
      success="Evidence saved."
      className="edit-block"
      submit={async (form) => {
        await api(route(record) + '/evidence' + (initial ? '/' + initial.id : ''), {
          method: initial ? 'PATCH' : 'POST',
          data: {
            title: string(form, 'title'),
            type: string(form, 'type'),
            description: string(form, 'description'),
            sourceUrl: nullable(form, 'sourceUrl'),
            collectedAt: instant(form, 'collectedAt'),
            personId: nullable(form, 'personId'),
            documentId: nullable(form, 'documentId'),
            version: initial?.version,
          },
        })
        close()
      }}
    >
      <div className="form-grid">
        <Field label="Evidence title">
          <input name="title" required maxLength={180} defaultValue={initial?.title} />
        </Field>
        <Field label="Type">
          <select name="type" defaultValue={initial?.type ?? 'IMAGE'}>
            {evidenceTypes.map((type) => (
              <option key={type} value={type}>
                {labels[type]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Source URL"
          hint={
            catalog.value?.hosts.length
              ? 'Image hosts · ' + catalog.value.hosts.join(', ')
              : 'Image links need an approved HTTPS host.'
          }
          wide
        >
          <input type="url" name="sourceUrl" maxLength={4096} defaultValue={initial?.sourceUrl ?? ''} />
        </Field>
        <Field label="Description" wide>
          <MultilineInput
            name="description"
            rows={3}
            maxLength={6000}
            defaultValue={initial?.description}
          />
        </Field>
        <Field label="Collected date and time (UTC)">
          <input
            type="datetime-local"
            name="collectedAt"
            defaultValue={timeValue(initial?.collectedAt)}
          />
        </Field>
        <Field label="Linked person">
          <select name="personId" defaultValue={initial?.personId ?? ''}>
            <option value="">None</option>
            <SelectOptions
              values={record.persons.map((person) => ({
                id: person.id,
                label: person.name + ' · ' + labels[person.role],
              }))}
            />
          </select>
        </Field>
        <Field label="Linked document">
          <select name="documentId" defaultValue={initial?.documentId ?? ''}>
            <option value="">None</option>
            <SelectOptions values={record.documents.map((doc) => ({ id: doc.id, label: doc.title }))} />
          </select>
        </Field>
      </div>
    </ActionForm>
  )
}

function EvidenceHistory({ path }: { path: string }) {
  const [page, setPage] = useState(1)
  const events = useResource<Page<Activity>>(path + '/history?page=' + page)
  return (
    <ResourceView resource={events}>
      {(data) => (
        <>
          <Events entries={data.items} details />
          <Pager page={page} setPage={setPage} more={data.more} />
        </>
      )}
    </ResourceView>
  )
}

function EvidenceRow({ record, item, edit }: { record: CaseRecord; item: Evidence; edit: () => void }) {
  const [note, setNote] = useState(false)
  const [history, setHistory] = useState(false)
  const date = useDate()
  const catalog = useCatalog()
  const path = route(record) + '/evidence/' + item.id
  const person = record.persons.find((person) => person.id === item.personId)
  const doc = record.documents.find((doc) => doc.id === item.documentId)
  return (
    <article className="evidence-row">
      <div className="section-head">
        <div>
          <span className="record-code">E-{String(item.reference).padStart(3, '0')}</span>
          <h3>{item.title}</h3>
          <div className="muted">
            {labels[item.type]} · Submitted by {item.submittedBy.displayName} · {date(item.createdAt)}
          </div>
        </div>
        {record.writable && (
          <div className="actions">
            <button onClick={edit}>Edit evidence</button>
            <Confirm
              label="Remove evidence"
              description={
                'Remove ' + item.title + ' from the active evidence list. Its history will be kept.'
              }
              run={() => remove(path, { version: item.version })}
            />
          </div>
        )}
      </div>
      {item.description && <p className="preserve prose">{item.description}</p>}
      {item.type === 'IMAGE' && item.sourceUrl ? (
        <RemoteImage url={item.sourceUrl} caption={item.title} hosts={catalog.value?.hosts ?? []} />
      ) : (
        item.sourceUrl &&
        safeHttps(item.sourceUrl) && (
          <p>
            <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
              Open original
            </a>
          </p>
        )
      )}
      {(item.collectedAt || person || doc) && (
        <div className="head-detail">
          {item.collectedAt && <span>Collected {date(item.collectedAt)}</span>}
          {person && <span>Person · {person.name}</span>}
          {doc && <Link to={'/documents/' + doc.id}>{doc.title}</Link>}
        </div>
      )}
      <div className="actions item-controls">
        {record.writable && (
          <button onClick={() => setNote(!note)} aria-expanded={note}>
            Add custody note
          </button>
        )}
        <button onClick={() => setHistory(!history)} aria-expanded={history}>
          Evidence history
        </button>
      </div>
      {note && record.writable && (
        <ActionForm
          label="Add note"
          onCancel={() => setNote(false)}
          success="Custody note added."
          submit={async (form) => {
            await api(path + '/notes', { method: 'POST', data: { note: string(form, 'note') } })
            setNote(false)
          }}
        >
          <Field label="Custody note">
            <MultilineInput name="note" required maxLength={3000} rows={2} />
          </Field>
        </ActionForm>
      )}
      {!!item.notes.length && (
        <ul className="line-list notes">
          {item.notes.map((entry) => (
            <li key={entry.id}>
              <span className="preserve">{entry.text}</span>
              <time dateTime={entry.createdAt}>{date(entry.createdAt)}</time>
            </li>
          ))}
        </ul>
      )}
      {history && <EvidenceHistory path={path} />}
    </article>
  )
}

export function EvidenceSection({ record }: { record: CaseRecord }) {
  const [draft, setDraft] = useState<Evidence | null | undefined>(undefined)
  return (
    <section className="surface padded">
      <div className="section-head">
        <h2>Evidence references</h2>
        {record.writable && draft === undefined && (
          <button onClick={() => setDraft(null)}>Add evidence</button>
        )}
      </div>
      <p className="muted">
        Remote files are hosted externally and may become unavailable. Evidence history records changes
        and custody notes.
      </p>
      {draft !== undefined && record.writable && (
        <EvidenceForm
          key={draft?.id ?? 'new'}
          record={record}
          initial={draft}
          close={() => setDraft(undefined)}
        />
      )}
      {record.evidence.length ? (
        record.evidence.map((item) => (
          <EvidenceRow item={item} record={record} key={item.id} edit={() => setDraft(item)} />
        ))
      ) : (
        <Empty>No evidence references have been added.</Empty>
      )}
    </section>
  )
}

function TaskForm({
  record,
  initial,
  close,
}: {
  record: CaseRecord
  initial: Task | null
  close: () => void
}) {
  return (
    <ActionForm
      label={initial ? 'Save task' : 'Create task'}
      onCancel={close}
      success="Task saved."
      className="edit-block"
      submit={async (form) => {
        await api(route(record) + '/tasks' + (initial ? '/' + initial.id : ''), {
          method: initial ? 'PATCH' : 'POST',
          data: {
            description: string(form, 'description'),
            priority: string(form, 'priority'),
            status: string(form, 'status'),
            dueAt: instant(form, 'dueAt'),
            assigneeId: nullable(form, 'assigneeId'),
            documentId: nullable(form, 'documentId'),
            evidenceId: nullable(form, 'evidenceId'),
            version: initial?.version,
          },
        })
        close()
      }}
    >
      <div className="form-grid">
        <Field label="Task description" wide>
          <MultilineInput
            name="description"
            required
            rows={3}
            maxLength={1800}
            defaultValue={initial?.description}
          />
        </Field>
        <Lookup
          name="assigneeId"
          label="Assignee"
          kind="officers"
          initial={
            initial?.assignee ? [{ id: initial.assignee.id, label: initial.assignee.displayName }] : []
          }
        />
        <Field label="Due date and time (UTC)">
          <input type="datetime-local" name="dueAt" defaultValue={timeValue(initial?.dueAt)} />
        </Field>
        <Field label="Priority">
          <select name="priority" defaultValue={initial?.priority ?? 'NORMAL'}>
            {priorities.map((item) => (
              <option key={item} value={item}>
                {labels[item]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select name="status" defaultValue={initial?.status ?? 'TODO'}>
            {taskStatuses.map((item) => (
              <option key={item} value={item}>
                {labels[item]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Linked document">
          <select name="documentId" defaultValue={initial?.documentId ?? ''}>
            <option value="">None</option>
            <SelectOptions values={record.documents.map((doc) => ({ id: doc.id, label: doc.title }))} />
          </select>
        </Field>
        <Field label="Linked evidence">
          <select name="evidenceId" defaultValue={initial?.evidenceId ?? ''}>
            <option value="">None</option>
            <SelectOptions
              values={record.evidence.map((item) => ({ id: item.id, label: item.title }))}
            />
          </select>
        </Field>
      </div>
    </ActionForm>
  )
}

export function TasksSection({ record }: { record: CaseRecord }) {
  const [draft, setDraft] = useState<Task | null | undefined>(undefined)
  const date = useDate()
  return (
    <section className="surface padded">
      <div className="section-head">
        <h2>Case tasks</h2>
        {record.writable && draft === undefined && (
          <button onClick={() => setDraft(null)}>New task</button>
        )}
      </div>
      {draft !== undefined && record.writable && (
        <TaskForm
          key={draft?.id ?? 'new'}
          record={record}
          initial={draft}
          close={() => setDraft(undefined)}
        />
      )}
      {record.tasks.length ? (
        <Table
          name="Case tasks"
          headings={['Task', 'Assigned to', 'Priority', 'Status', 'Due', 'Actions']}
        >
          {record.tasks.map((item) => {
            const doc = record.documents.find((doc) => doc.id === item.documentId)
            const evidence = record.evidence.find((evidence) => evidence.id === item.evidenceId)
            return (
              <tr key={item.id}>
                <td>
                  <div className="preserve">{item.description}</div>
                  {doc && <Link to={'/documents/' + doc.id}>{doc.title}</Link>}
                  {evidence && <span className="minor">Evidence · {evidence.title}</span>}
                </td>
                <td>{item.assignee?.displayName ?? 'Unassigned'}</td>
                <td>{labels[item.priority]}</td>
                <td>
                  {labels[item.status]}
                  {item.completedBy && (
                    <span className="minor">
                      {item.completedBy.displayName} · {date(item.completedAt)}
                    </span>
                  )}
                </td>
                <td className="date-cell">
                  {date(item.dueAt)}
                  {item.status !== 'DONE' && item.dueAt && new Date(item.dueAt) < new Date() && (
                    <span className="minor overdue">Overdue</span>
                  )}
                </td>
                <td>
                  {record.writable ? (
                    <div className="actions">
                      <button onClick={() => setDraft(item)}>Edit task</button>
                      <Confirm
                        label="Remove task"
                        description={
                          'Remove this task from the case. Its activity history will be kept.'
                        }
                        run={() =>
                          remove(route(record) + '/tasks/' + item.id, { version: item.version })
                        }
                      />
                    </div>
                  ) : (
                    'Read-only'
                  )}
                </td>
              </tr>
            )
          })}
        </Table>
      ) : (
        <Empty>No tasks on this case.</Empty>
      )}
    </section>
  )
}

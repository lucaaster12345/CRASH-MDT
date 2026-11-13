import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, query, string } from './api.js'
import { useDebounce, useResource, type Resource } from './state.js'
import { ActionForm, Empty, Field, MultilineInput, Pager, ResourceView, Table } from './ui.js'
import {
  chargeTotals,
  formatCustody,
  formatFine,
  type ChargeLine,
  type SuspectChargeSummary,
} from '../../../packages/shared/charges.js'
import type { CaseRecord, Charge, Page } from './types.js'

export function ChargeBreakdown({ summaries }: { summaries: SuspectChargeSummary[] }) {
  if (!summaries.length) return <Empty>No charges are assigned.</Empty>
  return (
    <div className="charge-breakdown">
      {summaries.map((suspect) => (
        <div key={suspect.personId}>
          <h3>{suspect.name}</h3>
          <ul>
            {suspect.charges.map((line) => (
              <li key={line.chargeId}>
                <strong>{line.code}</strong> · {line.title} × {line.count}
                <span className="minor">
                  {formatCustody(line.custodyMinutes * line.count)} ·{' '}
                  {formatFine(line.fineCents * line.count)}
                </span>
              </li>
            ))}
          </ul>
          <p>
            <strong>Total</strong> · {formatCustody(suspect.custodyMinutes)} ·{' '}
            {formatFine(suspect.fineCents)}
          </p>
        </div>
      ))}
    </div>
  )
}

export type ChargeReport = { version: number; suspects: SuspectChargeSummary[] }

export function ReportCharges({
  caseId,
  writable,
  resource,
}: {
  caseId: string
  writable: boolean
  resource: Resource<ChargeReport>
}) {
  return (
    <section className="surface padded">
      <div className="section-head">
        <h2>Suspect charges and totals</h2>
        {writable && (
          <Link className="button" to={'/cases/' + caseId + '?section=People'}>
            Manage suspect charges
          </Link>
        )}
      </div>
      <ResourceView resource={resource}>
        {(data) => <ChargeBreakdown summaries={data.suspects} />}
      </ResourceView>
    </section>
  )
}

export function SuspectCharges({
  record,
  person,
}: {
  record: CaseRecord
  person: CaseRecord['persons'][number]
}) {
  const [editing, setEditing] = useState<{ version: number; charges: ChargeLine[] } | null>(null)
  const summary = chargeTotals(person.charges)
  return (
    <div className="suspect-charges">
      {person.charges.length > 0 && (
        <p className="minor">
          Charges · {formatCustody(summary.custodyMinutes)} · {formatFine(summary.fineCents)}
        </p>
      )}
      {record.writable && !editing && (
        <button
          type="button"
          onClick={() => setEditing({ version: record.version, charges: person.charges })}
        >
          {person.charges.length ? 'Edit charges' : 'Assign charges'}
        </button>
      )}
      {record.writable && editing && (
        <SuspectChargeForm
          record={record}
          person={person}
          initial={editing.charges}
          version={editing.version}
          close={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function SuspectChargeForm({
  record,
  person,
  initial,
  version,
  close,
}: {
  record: CaseRecord
  person: CaseRecord['persons'][number]
  initial: ChargeLine[]
  version: number
  close: () => void
}) {
  const [lines, setLines] = useState<(ChargeLine & { catalogVersion?: number })[]>(initial)
  const [q, setQ] = useState('')
  const term = useDebounce(q.trim())
  const resource = useResource<Page<Charge>>('/penal-code' + query({ q: term }))
  const total = chargeTotals(lines)
  return (
    <ActionForm
      label="Save charges"
      onCancel={close}
      className="edit-block"
      success={'Charges saved for ' + person.name + '.'}
      submit={async () => {
        await api('/cases/' + record.id + '/persons/' + person.id + '/charges', {
          method: 'PUT',
          data: {
            version,
            charges: lines.map(({ chargeId, count, catalogVersion }) => ({
              chargeId,
              count,
              catalogVersion,
            })),
          },
        })
        close()
      }}
    >
      <Field label="Find a penal code charge">
        <input
          type="search"
          value={q}
          maxLength={120}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault()
          }}
        />
      </Field>
      <ResourceView resource={resource}>
        {(data) => {
          const choices = data.items.filter((item) => !lines.some((line) => line.chargeId === item.id))
          return choices.length ? (
            <>
              <ul className="lookup-results" aria-label="Available charges">
                {choices.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={lines.length >= 100}
                      onClick={() => {
                        const { id, code, title, custodyMinutes, fineCents, version } = item
                        setLines([
                          ...lines,
                          {
                            chargeId: id,
                            code,
                            title,
                            custodyMinutes,
                            fineCents,
                            count: 1,
                            catalogVersion: version,
                          },
                        ])
                      }}
                    >
                      {item.code} · {item.title} · {formatCustody(item.custodyMinutes)} ·{' '}
                      {formatFine(item.fineCents)}
                    </button>
                  </li>
                ))}
              </ul>
              {data.more && <p className="muted">Search by code or title to narrow the results.</p>}
            </>
          ) : (
            <p className="muted">No unassigned charges match this search.</p>
          )
        }}
      </ResourceView>
      {lines.length > 0 && (
        <ul className="line-list">
          {lines.map((line) => (
            <li key={line.chargeId}>
              <div>
                <strong>
                  {line.code} · {line.title}
                </strong>
                <span className="minor">
                  {formatCustody(line.custodyMinutes)} · {formatFine(line.fineCents)} per count
                </span>
              </div>
              <div className="actions">
                <Field label={'Count for ' + line.code}>
                  <input
                    required
                    min={1}
                    max={100}
                    type="number"
                    defaultValue={line.count}
                    onChange={(e) => {
                      const count = e.currentTarget.valueAsNumber
                      if (Number.isInteger(count) && count >= 1 && count <= 100) {
                        setLines((current) =>
                          current.map((item) =>
                            item.chargeId === line.chargeId ? { ...item, count } : item,
                          ),
                        )
                      }
                    }}
                  />
                </Field>
                <button
                  type="button"
                  aria-label={'Remove ' + line.code}
                  onClick={() =>
                    setLines((current) => current.filter((item) => item.chargeId !== line.chargeId))
                  }
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p aria-live="polite">
        <strong>Estimated total</strong> · {formatCustody(total.custodyMinutes)} ·{' '}
        {formatFine(total.fineCents)}
      </p>
    </ActionForm>
  )
}

export function PenalCode({ admin = false }: { admin?: boolean }) {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [archived, setArchived] = useState('')
  const [editing, setEditing] = useState<Charge | null | undefined>()
  const resource = useResource<Page<Charge>>(
    '/penal-code' + query({ q: useDebounce(q), page, archived }),
  )
  return (
    <section className="surface padded">
      <div className="section-head">
        <h2>{admin ? 'Penal code entries' : 'Charge lookup'}</h2>
        {admin && (
          <button type="button" onClick={() => setEditing(null)}>
            New charge
          </button>
        )}
      </div>
      <div className="form-grid index-search">
        <Field label="Search the penal code">
          <input
            type="search"
            value={q}
            maxLength={120}
            onChange={(e) => {
              setQ(e.currentTarget.value)
              setPage(1)
            }}
          />
        </Field>
        {admin && (
          <Field label="Status">
            <select
              value={archived}
              onChange={(e) => {
                setArchived(e.currentTarget.value)
                setPage(1)
              }}
            >
              <option value="">Active</option>
              <option value="yes">Archived</option>
              <option value="all">All entries</option>
            </select>
          </Field>
        )}
      </div>
      {admin && editing !== undefined && (
        <ChargeForm key={editing?.id ?? 'new'} initial={editing} close={() => setEditing(undefined)} />
      )}
      <ResourceView resource={resource}>
        {(data) => (
          <>
            {data.items.length ? (
              <Table
                name="Penal code"
                headings={[
                  'Code and charge',
                  'Time per count',
                  'Fine per count',
                  ...(admin ? ['Actions'] : []),
                ]}
              >
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="record-code">{item.code}</span>
                      <strong>{item.title}</strong>
                      {item.description && <span className="minor preserve">{item.description}</span>}
                      {item.archivedAt && <span className="minor">Archived</span>}
                    </td>
                    <td>{formatCustody(item.custodyMinutes)}</td>
                    <td>{formatFine(item.fineCents)}</td>
                    {admin && (
                      <td>
                        <button
                          type="button"
                          aria-label={'Edit charge ' + item.code}
                          onClick={() => setEditing(item)}
                        >
                          Edit charge
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No penal code entries match this search.</Empty>
            )}
            <Pager page={page} setPage={setPage} more={data.more} />
          </>
        )}
      </ResourceView>
    </section>
  )
}

function ChargeForm({ initial, close }: { initial: Charge | null; close: () => void }) {
  return (
    <ActionForm
      label={initial ? 'Save charge' : 'Create charge'}
      className="edit-block"
      onCancel={close}
      success="Penal code saved."
      submit={async (form) => {
        const fine = string(form, 'fine')
        if (!/^\d+(?:\.\d{1,2})?$/.test(fine))
          throw new Error('Enter a dollar amount with up to two decimal places.')
        const [dollars, cents = ''] = fine.split('.')
        await api('/penal-code' + (initial ? '/' + initial.id : ''), {
          method: initial ? 'PATCH' : 'POST',
          data: {
            code: string(form, 'code'),
            title: string(form, 'title'),
            description: string(form, 'description'),
            custodyMinutes: Number(string(form, 'minutes')),
            fineCents: Number(dollars) * 100 + Number(cents.padEnd(2, '0')),
            archived: form.has('archived'),
            version: initial?.version,
          },
        })
        close()
      }}
    >
      <div className="form-grid">
        <Field label="Statute or charge code">
          <input name="code" required maxLength={40} defaultValue={initial?.code} />
        </Field>
        <Field label="Charge title">
          <input name="title" required maxLength={180} defaultValue={initial?.title} />
        </Field>
        <Field label="Custody time in minutes">
          <input
            name="minutes"
            type="number"
            required
            min={0}
            max={10_000_000}
            defaultValue={initial?.custodyMinutes ?? 0}
          />
        </Field>
        <Field label="Fine (USD)">
          <input
            name="fine"
            inputMode="decimal"
            required
            maxLength={12}
            defaultValue={((initial?.fineCents ?? 0) / 100).toFixed(2)}
          />
        </Field>
        <Field label="Description" wide>
          <MultilineInput
            name="description"
            rows={3}
            maxLength={4000}
            defaultValue={initial?.description}
          />
        </Field>
        {initial && (
          <label className="check">
            <input type="checkbox" name="archived" defaultChecked={!!initial.archivedAt} />
            Archive this charge
          </label>
        )}
      </div>
    </ActionForm>
  )
}

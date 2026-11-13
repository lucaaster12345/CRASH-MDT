import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, lines, query, string } from './api.js'
import { useDate, useDebounce, useNotice, useResource, useSession } from './state.js'
import {
  MultilineInput,
  Confirm,
  Empty,
  Events,
  Field,
  ActionForm,
  PageHead,
  Pager,
  ResourceView,
  SelectOptions,
  Table,
  remove,
} from './ui.js'
import { labels, roles } from '../../../packages/shared/validation.js'
import type { Account, Activity, AdminCatalog, Credential, Page } from './types.js'
import { PenalCode } from './charges.js'

const sections = [
  'Accounts',
  'Tags',
  'Case statuses',
  'Penal code',
  'Document templates',
  'Evidence hosts',
  'Audit log',
  'System',
] as const
type Section = (typeof sections)[number]

function Accounts() {
  const { user } = useSession()
  const date = useDate()
  const notice = useNotice()
  const [create, setCreate] = useState(false)
  const [credential, setCredential] = useState<(Credential & { username: string }) | null>(null)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [roleFor, setRoleFor] = useState<Account | null>(null)
  const results = useResource<Page<Account>>('/accounts' + query({ q: useDebounce(q), page }))
  const available = roles.filter((role) => user.username === 'mercia' || role !== 'ADMIN')
  async function action(account: Account, action: string) {
    const result = await api<Partial<Credential>>('/accounts/' + account.id + '/action', {
      method: 'POST',
      data: { action },
    })
    if (result.code && result.expiresAt)
      setCredential({ code: result.code, expiresAt: result.expiresAt, username: account.username })
    else notice('Account updated.')
  }
  return (
    <section className="surface padded">
      <div className="section-head">
        <h2>Issued accounts</h2>
        <button onClick={() => setCreate(!create)} aria-expanded={create}>
          Provision account
        </button>
      </div>
      {credential && (
        <section className="credential" aria-label="One-time credential">
          <h3>One-time code for {credential.username}</h3>
          <p>Deliver it privately. It expires {date(credential.expiresAt)}.</p>
          <Field label="Copy the code">
            <input
              className="record-code"
              readOnly
              value={credential.code}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <button onClick={() => setCredential(null)}>Hide code</button>
        </section>
      )}
      {create && (
        <ActionForm
          className="edit-block"
          label="Create account"
          onCancel={() => setCreate(false)}
          submit={async (form) => {
            const result = await api<Credential & { user: Account }>('/accounts', {
              method: 'POST',
              data: {
                username: string(form, 'username'),
                displayName: string(form, 'displayName'),
                badge: string(form, 'badge') || null,
                role: string(form, 'role'),
              },
            })
            setCredential({ ...result, username: result.user.username })
            setCreate(false)
          }}
        >
          <div className="form-grid">
            <Field label="Username">
              <input name="username" required minLength={3} maxLength={48} autoComplete="off" />
            </Field>
            <Field label="Display name">
              <input name="displayName" required maxLength={140} />
            </Field>
            <Field label="Badge or callsign">
              <input name="badge" maxLength={48} />
            </Field>
            <Field label="Role">
              <select name="role" defaultValue="INVESTIGATOR">
                {available.map((role) => (
                  <option key={role} value={role}>
                    {labels[role]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </ActionForm>
      )}
      <div className="index-search">
        <Field label="Find an account">
          <input
            type="search"
            maxLength={100}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
          />
        </Field>
      </div>
      {roleFor && (
        <ActionForm
          className="edit-block"
          key={roleFor.id}
          label="Save account"
          onCancel={() => setRoleFor(null)}
          success="Account updated."
          submit={async (form) => {
            await api('/accounts/' + roleFor.id, {
              method: 'PATCH',
              data: {
                username: string(form, 'username'),
                displayName: string(form, 'displayName'),
                badge: string(form, 'badge') || null,
                role: string(form, 'role'),
                version: roleFor.version,
              },
            })
            if (credential?.username === roleFor.username) setCredential(null)
            setRoleFor(null)
          }}
        >
          <div className="form-grid">
            <Field label="Username">
              <input
                name="username"
                required
                minLength={3}
                maxLength={48}
                defaultValue={roleFor.username}
              />
            </Field>
            <Field label="Display name">
              <input name="displayName" required maxLength={140} defaultValue={roleFor.displayName} />
            </Field>
            <Field label="Badge or callsign">
              <input name="badge" maxLength={48} defaultValue={roleFor.badge ?? ''} />
            </Field>
            <Field
              label="Role"
              hint="Changing the username or role ends current sessions and invalidates outstanding codes."
            >
              <select name="role" defaultValue={roleFor.role}>
                {available.map((role) => (
                  <option key={role} value={role}>
                    {labels[role]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </ActionForm>
      )}
      <ResourceView resource={results}>
        {(data) => (
          <>
            {data.items.length ? (
              <Table name="Issued accounts" headings={['Account', 'Role', 'Status', 'Actions']}>
                {data.items.map((account) => {
                  const allowed =
                    account.username !== 'mercia' &&
                    user.id !== account.id &&
                    (account.role !== 'ADMIN' || user.username === 'mercia')
                  return (
                    <tr key={account.id}>
                      <td>
                        <strong>{account.displayName}</strong>
                        <span className="minor">
                          {account.username}
                          {account.badge && ' · ' + account.badge}
                        </span>
                      </td>
                      <td>{labels[account.role]}</td>
                      <td>
                        {account.disabledAt
                          ? 'Disabled'
                          : account.activated
                            ? 'Active'
                            : 'Awaiting activation'}
                      </td>
                      <td>
                        {allowed ? (
                          <div className="actions">
                            <button type="button" onClick={() => setRoleFor(account)}>
                              Edit account
                            </button>
                            <Confirm
                              label={account.disabledAt ? 'Reactivate account' : 'Disable account'}
                              description={
                                account.disabledAt
                                  ? 'Allow ' + account.username + ' to sign in again.'
                                  : 'Block sign-in and end sessions for ' + account.username + '.'
                              }
                              run={() => action(account, account.disabledAt ? 'enable' : 'disable')}
                            />
                            {!account.disabledAt && (
                              <Confirm
                                label={account.activated ? 'Issue reset code' : 'Issue activation code'}
                                description={
                                  'Issue a fresh one-time code for ' +
                                  account.username +
                                  ' and invalidate any earlier code.'
                                }
                                run={() => action(account, 'issue')}
                              />
                            )}
                            <Confirm
                              label="Revoke sessions"
                              description={'Sign ' + account.username + ' out of every active session.'}
                              run={() => action(account, 'revoke')}
                            />
                            <Confirm
                              label="Delete account"
                              danger
                              confirmation={account.username}
                              description={
                                'Permanently remove sign-in and assignments for ' +
                                account.username +
                                '. Case records and historical attribution are kept.'
                              }
                              run={async (confirmation) => {
                                await remove('/accounts/' + account.id, {
                                  version: account.version,
                                  confirmation,
                                })
                                if (credential?.username === account.username) setCredential(null)
                                if (roleFor?.id === account.id) setRoleFor(null)
                                notice('Account deleted.')
                              }}
                            />
                          </div>
                        ) : account.username === 'mercia' ? (
                          'Protected master account'
                        ) : (
                          'Managed by another administrator'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </Table>
            ) : (
              <Empty>No matching accounts.</Empty>
            )}
            <Pager page={page} more={data.more} setPage={setPage} />
          </>
        )}
      </ResourceView>
    </section>
  )
}

function Tags({ catalog }: { catalog: AdminCatalog }) {
  const [editing, setEditing] = useState<AdminCatalog['tags'][number] | null>(null)
  const [merging, setMerging] = useState<AdminCatalog['tags'][number] | null>(null)
  const [formKey, setFormKey] = useState(0)
  return (
    <section className="surface padded">
      <h2>Tags</h2>
      <ActionForm
        label={editing ? 'Rename tag' : 'Create tag'}
        key={editing?.id ?? formKey}
        onCancel={editing ? () => setEditing(null) : undefined}
        success={editing ? 'Tag renamed.' : 'Tag created.'}
        submit={async (form) => {
          await api('/admin/tags' + (editing ? '/' + editing.id : ''), {
            method: editing ? 'PATCH' : 'POST',
            data: { label: string(form, 'label') },
          })
          setEditing(null)
          setFormKey(formKey + 1)
        }}
      >
        <Field label="Tag label">
          <input name="label" required maxLength={60} defaultValue={editing?.label} />
        </Field>
      </ActionForm>
      {merging && (
        <ActionForm
          key={merging.id}
          className="edit-block"
          label="Merge tags"
          onCancel={() => setMerging(null)}
          success="Tags merged."
          submit={async (form) => {
            await remove('/admin/tags/' + merging.id, { mergeInto: string(form, 'mergeInto') })
            setMerging(null)
          }}
        >
          <Field
            label={'Merge ' + merging.label + ' into'}
            hint="The source tag will be removed after its associations move."
          >
            <select name="mergeInto" required defaultValue="">
              <option value="">Choose a tag</option>
              <SelectOptions values={catalog.tags.filter((tag) => tag.id !== merging.id)} />
            </select>
          </Field>
        </ActionForm>
      )}
      {catalog.tags.length ? (
        <Table name="Tags and usage" headings={['Tag', 'Cases', 'Profiles', 'Actions']}>
          {catalog.tags.map((tag) => (
            <tr key={tag.id}>
              <td>{tag.label}</td>
              <td>{tag._count.cases}</td>
              <td>{tag._count.profiles}</td>
              <td>
                <div className="actions">
                  <button onClick={() => setEditing(tag)}>Rename</button>
                  {catalog.tags.length > 1 && <button onClick={() => setMerging(tag)}>Merge</button>}
                  <Confirm
                    label="Delete tag"
                    danger
                    description={'Remove ' + tag.label + ' and its case and profile associations.'}
                    run={() => remove('/admin/tags/' + tag.id, {})}
                  />
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>No tags have been created.</Empty>
      )}
    </section>
  )
}

const core = ['draft', 'active', 'pending', 'closed', 'archived']
function Statuses({ catalog }: { catalog: AdminCatalog }) {
  const [editing, setEditing] = useState<AdminCatalog['statuses'][number] | null>(null)
  const [deleting, setDeleting] = useState<AdminCatalog['statuses'][number] | null>(null)
  const [formKey, setFormKey] = useState(0)
  return (
    <section className="surface padded">
      <h2>Case statuses</h2>
      <ActionForm
        label={editing ? 'Save status' : 'Add status'}
        key={editing?.id ?? formKey}
        onCancel={editing ? () => setEditing(null) : undefined}
        success="Case status saved."
        submit={async (form) => {
          await api('/admin/statuses' + (editing ? '/' + editing.id : ''), {
            method: editing ? 'PATCH' : 'POST',
            data: {
              id: string(form, 'id'),
              label: string(form, 'label'),
              position: Number(string(form, 'position')),
            },
          })
          setEditing(null)
          setFormKey(formKey + 1)
        }}
      >
        <div className="form-grid">
          {!editing && (
            <Field label="Status key" hint="Use lowercase letters, numbers, or hyphens.">
              <input name="id" required maxLength={48} />
            </Field>
          )}
          <Field label="Display label">
            <input name="label" required maxLength={70} defaultValue={editing?.label} />
          </Field>
          <Field label="Sort position">
            <input
              name="position"
              type="number"
              min={0}
              max={1000}
              required
              defaultValue={editing?.position ?? 50}
            />
          </Field>
        </div>
      </ActionForm>
      {deleting && (
        <ActionForm
          className="edit-block"
          key={deleting.id}
          label="Reassign cases and delete status"
          onCancel={() => setDeleting(null)}
          success="Status deleted."
          submit={async (form) => {
            await remove('/admin/statuses/' + deleting.id, {
              destination: string(form, 'destination') || undefined,
            })
            setDeleting(null)
          }}
        >
          <Field
            label={'Replace ' + deleting.label + ' with'}
            hint="A replacement is required if current or archived cases reference the status."
          >
            <select name="destination" defaultValue="">
              <option value="">No replacement</option>
              <SelectOptions
                values={catalog.statuses.filter(
                  (item) => !['draft', 'closed', 'archived', deleting.id].includes(item.id),
                )}
              />
            </select>
          </Field>
        </ActionForm>
      )}
      <Table name="Case statuses" headings={['Status', 'Key', 'Position', 'Current usage', 'Actions']}>
        {catalog.statuses.map((status) => (
          <tr key={status.id}>
            <td>{status.label}</td>
            <td className="record-code">{status.id}</td>
            <td>{status.position}</td>
            <td>{status._count.cases}</td>
            <td>
              <div className="actions">
                <button onClick={() => setEditing(status)}>Edit</button>
                {!core.includes(status.id) && (
                  <button onClick={() => setDeleting(status)}>Delete or reassign</button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </Table>
    </section>
  )
}

function Templates({ catalog }: { catalog: AdminCatalog }) {
  const [type, setType] = useState<AdminCatalog['templates'][number]['type']>('INCIDENT')
  const template = catalog.templates.find((item) => item.type === type)
  return (
    <section className="surface padded">
      <h2>Document templates</h2>
      <Field label="Document type">
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          {catalog.templates.map((item) => (
            <option key={item.type} value={item.type}>
              {labels[item.type]}
            </option>
          ))}
        </select>
      </Field>
      <ActionForm
        key={type}
        label="Save template"
        success="Template saved."
        submit={async (form) => {
          await api('/admin/templates/' + type, {
            method: 'PUT',
            data: { headings: lines(form, 'headings') },
          })
        }}
      >
        <Field
          label="Starting headings"
          hint="Enter one heading per line. Changes apply when a document is created."
        >
          <MultilineInput rows={8} name="headings" defaultValue={template?.headings.join('\n')} />
        </Field>
      </ActionForm>
    </section>
  )
}

function Hosts({ catalog }: { catalog: AdminCatalog }) {
  return (
    <section className="surface padded">
      <h2>Approved image hosts</h2>
      <ActionForm
        label="Save hosts"
        success="Hosts saved. Reload open browser pages to apply their new image policy."
        submit={async (form) => {
          await api('/admin/hosts', { method: 'PUT', data: { hosts: lines(form, 'hosts') } })
        }}
      >
        <Field
          label="Public HTTPS hostnames"
          hint="Enter one exact hostname per line, without a protocol or path."
        >
          <MultilineInput name="hosts" rows={8} defaultValue={catalog.hosts.join('\n')} />
        </Field>
      </ActionForm>
    </section>
  )
}

function Audit() {
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const term = useDebounce(q)
  const events = useResource<Page<Activity>>('/admin/audit' + query({ q: term, page }))
  return (
    <section className="surface padded">
      <h2>Audit log</h2>
      <Field label="Search audit log">
        <input
          type="search"
          maxLength={160}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
          placeholder="Action, account or case number"
        />
      </Field>
      <ResourceView resource={events}>
        {(data) => (
          <>
            <Events entries={data.items} details />
            <Pager page={page} more={data.more} setPage={setPage} />
          </>
        )}
      </ResourceView>
    </section>
  )
}

export function Administration() {
  const [active, setActive] = useState<Section>('Accounts')
  const catalog = useResource<AdminCatalog>('/admin/catalog')
  const date = useDate()
  return (
    <div className="page">
      <PageHead
        title="Administration"
        actions={
          <Link className="button" to="/cases?archived=only">
            Archived cases
          </Link>
        }
      />
      <nav className="section-nav" aria-label="Administration sections">
        {sections.map((item) => (
          <button
            type="button"
            aria-pressed={active === item}
            onClick={() => setActive(item)}
            key={item}
          >
            {item}
          </button>
        ))}
      </nav>
      {active === 'Accounts' ? (
        <Accounts />
      ) : active === 'Penal code' ? (
        <PenalCode admin />
      ) : active === 'Audit log' ? (
        <Audit />
      ) : (
        <ResourceView resource={catalog}>
          {(data) =>
            active === 'Tags' ? (
              <Tags catalog={data} />
            ) : active === 'Case statuses' ? (
              <Statuses catalog={data} />
            ) : active === 'Document templates' ? (
              <Templates catalog={data} />
            ) : active === 'Evidence hosts' ? (
              <Hosts catalog={data} />
            ) : (
              <section className="surface padded">
                <h2>System health</h2>
                <dl className="facts">
                  <dt>Database</dt>
                  <dd>{data.database}</dd>
                  <dt>Last recorded backup</dt>
                  <dd>
                    {data.backup?.at
                      ? date(data.backup.at) + (data.backup.file ? ' · ' + data.backup.file : '')
                      : 'No backup status has been recorded.'}
                  </dd>
                </dl>
                <div className="actions">
                  <Link className="button" to="/cases?archived=only">
                    Browse archived cases
                  </Link>
                  <Link className="button" to="/profiles?archived=only">
                    Browse archived profiles
                  </Link>
                </div>
              </section>
            )
          }
        </ResourceView>
      )}
    </div>
  )
}

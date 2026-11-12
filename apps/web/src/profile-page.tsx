import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, dateValue, lines, nullable, query, selected, string } from './api.js'
import { useCatalog, useDate, useDebounce, useResource, useSession } from './state.js'
import {
  MultilineInput,
  Confirm,
  Empty,
  Events,
  Field,
  ActionForm,
  PageHead,
  RemoteImage,
  ResourceView,
  SelectOptions,
} from './ui.js'
import type { Page, ProfileCard, ProfileRecord } from './types.js'

const role = { SUSPECT: 'Suspect', WITNESS: 'Civilian or witness', OFFICER: 'Involved officer' }
function data(form: FormData) {
  return {
    fullName: string(form, 'fullName'),
    aliases: lines(form, 'aliases'),
    identifier: nullable(form, 'identifier'),
    birthDate: nullable(form, 'birthDate'),
    contact: string(form, 'contact'),
    portraitUrl: nullable(form, 'portraitUrl'),
    confirmedNotes: string(form, 'confirmedNotes'),
    unverifiedNotes: string(form, 'unverifiedNotes'),
    tagIds: selected(form, 'tagIds'),
  }
}
function ProfileFields({ record }: { record?: ProfileRecord }) {
  const catalog = useCatalog()
  const [name, setName] = useState(record?.fullName ?? '')
  const [composing, setComposing] = useState(false)
  const settled = useDebounce(name.trim())
  const suggestions = useResource<Page<ProfileCard>>(
    !record && !composing && settled.length >= 3
      ? '/search/profiles' + query({ q: settled, archived: 'include' })
      : null,
  )
  return (
    <div className="form-grid">
      <div>
        <Field label="Full name">
          <input
            name="fullName"
            required
            maxLength={180}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
          />
        </Field>
        <ResourceView resource={suggestions}>
          {(data) =>
            data.items.length ? (
              <div className="muted">
                <span>Possible existing profiles</span>
                <ul>
                  {data.items.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      <Link to={'/profiles/' + item.id} target="_blank" rel="noreferrer">
                        {item.fullName}
                      </Link>
                      {item.archivedAt && ' · Archived'}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          }
        </ResourceView>
      </div>
      <Field label="Fictional or state identifier">
        <input name="identifier" maxLength={100} defaultValue={record?.identifier ?? ''} />
      </Field>
      <Field label="Date of birth">
        <input name="birthDate" type="date" defaultValue={dateValue(record?.birthDate)} />
      </Field>
      <Field label="Portrait URL" hint="Use a direct HTTPS URL on an approved image host.">
        <input
          name="portraitUrl"
          type="url"
          maxLength={4096}
          defaultValue={record?.portraitUrl ?? ''}
        />
      </Field>
      <Field label="Aliases" hint="One alias per line.">
        <MultilineInput name="aliases" rows={3} defaultValue={record?.aliases.join('\n')} />
      </Field>
      <Field label="Tags" hint="Use Ctrl or Command to choose multiple tags.">
        <select
          name="tagIds"
          multiple
          size={4}
          defaultValue={record?.tags.map((item) => item.tagId) ?? []}
        >
          <SelectOptions values={catalog.value?.tags ?? record?.tags.map((item) => item.tag) ?? []} />
        </select>
      </Field>
      <Field label="Contact information" wide>
        <MultilineInput name="contact" rows={2} maxLength={1200} defaultValue={record?.contact} />
      </Field>
      <Field label="Confirmed factual notes" wide>
        <MultilineInput
          name="confirmedNotes"
          rows={4}
          maxLength={12000}
          defaultValue={record?.confirmedNotes}
        />
      </Field>
      <Field label="Unverified notes" hint="Keep sensitive case-specific notes in the case." wide>
        <MultilineInput
          name="unverifiedNotes"
          rows={4}
          maxLength={12000}
          defaultValue={record?.unverifiedNotes}
        />
      </Field>
    </div>
  )
}

export function NewProfile() {
  const navigate = useNavigate()
  return (
    <div className="page reading">
      <PageHead
        title="New civilian profile"
        kicker="PROFILE INTAKE"
        detail="Search for existing names or aliases before creating a profile."
      />
      <section className="surface padded">
        <ActionForm
          label="Create profile"
          onCancel={() => navigate('/profiles')}
          success="Civilian profile created."
          submit={async (form) => {
            const record = await api<{ id: string }>('/profiles', { method: 'POST', data: data(form) })
            navigate('/profiles/' + record.id)
          }}
        >
          <ProfileFields />
        </ActionForm>
      </section>
    </div>
  )
}

export function ProfilePage({ record }: { record: ProfileRecord }) {
  const [editing, setEditing] = useState<ProfileRecord | null>(null)
  const { user } = useSession()
  const catalog = useCatalog()
  const date = useDate()
  const path = '/profiles/' + record.id
  const canEdit = user.role !== 'VIEWER'
  return (
    <div className="page">
      <Link className="crumb" to="/profiles">
        Civilian profiles
      </Link>
      <PageHead
        title={record.fullName}
        kicker="CIVILIAN PROFILE"
        detail={
          <>
            {record.archivedAt && <span className="state">Archived</span>}
            {record.identifier && <span className="record-code">{record.identifier}</span>}
            <span>Updated {date(record.updatedAt)}</span>
          </>
        }
        actions={
          canEdit && (
            <>
              {!record.archivedAt && !editing && (
                <button className="primary" onClick={() => setEditing(record)}>
                  Edit profile
                </button>
              )}
              <Confirm
                label={record.archivedAt ? 'Restore profile' : 'Archive profile'}
                description={
                  record.archivedAt
                    ? 'Make this profile editable and include it in current searches.'
                    : 'Move this profile into archive search. Existing case appearances will remain linked.'
                }
                run={() =>
                  api(path + '/archive', {
                    method: 'POST',
                    data: { archived: !record.archivedAt, version: record.version },
                  })
                }
              />
            </>
          )
        }
      />
      {editing && canEdit && !record.archivedAt ? (
        <section className="surface padded">
          <h2>Edit profile</h2>
          <ActionForm
            onCancel={() => setEditing(null)}
            success="Profile saved."
            submit={async (form) => {
              await api(path, { method: 'PATCH', data: { ...data(form), version: editing.version } })
              setEditing(null)
            }}
          >
            <ProfileFields record={editing} />
          </ActionForm>
        </section>
      ) : (
        <div className="record-grid">
          <section className="surface padded">
            <h2>Profile details</h2>
            <dl className="facts">
              <dt>Aliases</dt>
              <dd>{record.aliases.join(', ') || '—'}</dd>
              <dt>Date of birth</dt>
              <dd>{dateValue(record.birthDate) || '—'}</dd>
              <dt>Contact</dt>
              <dd>{record.contact || '—'}</dd>
              <dt>Tags</dt>
              <dd>{record.tags.map((item) => item.tag.label).join(', ') || '—'}</dd>
            </dl>
            <h3>Confirmed factual notes</h3>
            <p className="prose preserve">{record.confirmedNotes || 'No confirmed notes.'}</p>
            <h3>Unverified notes</h3>
            <p className="prose preserve">{record.unverifiedNotes || 'No unverified notes.'}</p>
          </section>
          <section className="surface padded">
            <h2>Case appearances</h2>
            {record.appearances.length ? (
              <ul className="line-list">
                {record.appearances.map((item) => (
                  <li key={item.id}>
                    <div>
                      <Link to={'/cases/' + item.case.id}>
                        {item.case.number} · {item.case.title}
                      </Link>
                      <span className="minor">
                        {role[item.role]} · {item.name}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No case appearances are visible.</Empty>
            )}
            {record.portraitUrl && (
              <RemoteImage
                url={record.portraitUrl}
                caption={record.fullName}
                hosts={catalog.value?.hosts ?? []}
              />
            )}
          </section>
        </div>
      )}
      <section className="surface padded">
        <h2>Profile history</h2>
        <Events entries={record.history} />
      </section>
    </div>
  )
}

import { api } from './api.js'
import { useResource } from './state.js'
import { ActionForm, Confirm, Field, PageHead, ResourceView } from './ui.js'

export function AccountSecurity({
  hasPending,
  onPasswordChanged,
}: {
  hasPending: boolean
  onPasswordChanged: () => void
}) {
  const sessions = useResource<{ otherSessions: number }>('/auth/sessions')
  return (
    <div className="page reading">
      <PageHead title="Account security" />
      <section className="surface padded">
        <h2>Change password</h2>
        <p className="muted">
          Use at least 12 characters. Changing your password signs you out of every session.
        </p>
        {hasPending && (
          <p className="callout" role="status">
            Save your open document edits before changing your password.
          </p>
        )}
        {!hasPending && (
          <ActionForm
            label="Change password and sign out"
            submit={async (form) => {
              if (form.get('password') !== form.get('confirmation'))
                throw new Error('The new passwords do not match.')
              await api('/auth/password', {
                method: 'POST',
                data: { current: form.get('current'), password: form.get('password') },
              })
              onPasswordChanged()
            }}
          >
            <Field label="Current password">
              <input
                type="password"
                name="current"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </Field>
            <Field label="New password">
              <input
                type="password"
                name="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </Field>
            <Field label="Confirm new password">
              <input
                type="password"
                name="confirmation"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </Field>
          </ActionForm>
        )}
      </section>
      <section className="surface padded">
        <h2>Other sessions</h2>
        <ResourceView resource={sessions}>
          {(data) => (
            <>
              <p>
                {data.otherSessions === 1
                  ? '1 other active session'
                  : data.otherSessions + ' other active sessions'}
              </p>
              {data.otherSessions > 0 && (
                <Confirm
                  label="Sign out other sessions"
                  description="End all sessions for your account except this browser session."
                  run={() => api('/auth/sessions', { method: 'DELETE' })}
                />
              )}
            </>
          )}
        </ResourceView>
      </section>
    </div>
  )
}

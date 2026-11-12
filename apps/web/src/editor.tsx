import { useContext, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { JSONContent } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import * as Y from 'yjs'
import { documentField, richTextExtensions } from '../../../packages/shared/rich-text.js'
import {
  documentAccessChanged,
  durabilityProof,
  invalidDocumentUpdate,
} from '../../../packages/shared/durability.js'
import { imageAllowed, labels, safeHttps } from '../../../packages/shared/validation.js'
import { api, string } from './api.js'
import {
  LiveContext,
  PendingContext,
  useCatalog,
  useDate,
  useNotice,
  useResource,
  useSession,
} from './state.js'
import {
  AsyncButton,
  Confirm,
  Empty,
  Field,
  ActionForm,
  PageHead,
  Pager,
  ResourceView,
  remove,
} from './ui.js'
import type { DocumentRecord, Durable, Page, Revision } from './types.js'

type Connection = { doc: Y.Doc; provider: HocuspocusProvider }
type Status =
  'Connecting' | 'Connected' | 'Saving' | 'Saved' | 'Reconnecting' | 'Unsynced' | 'Read-only'

async function stateDigest(doc: Y.Doc) {
  const state = durabilityProof(doc)
  const hash = await crypto.subtle.digest('SHA-256', state)
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function useConnection(record: DocumentRecord, tabKey: string) {
  const [connection, setConnection] = useState<Connection | null>(null)
  const [status, setStatus] = useState<Status>('Connecting')
  const [saved, setSaved] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const pending = useContext(PendingContext)
  const { refresh } = useContext(LiveContext)
  const { id, epoch, writable } = record
  useEffect(() => {
    let alive = true
    let denied = false
    let connected = false
    let synchronized = false
    let previouslySynced = false
    let dirty = false
    let checking = false
    let generation = 0
    let durableHash = ''
    let lastUpdate = 0
    const room = id + '.' + epoch
    const url =
      location.origin.replace(/^http/, 'ws') + '/collaboration?room=' + encodeURIComponent(room)
    const doc = new Y.Doc()
    doc.getXmlFragment(documentField)
    const blocked = (reason: string) => {
      if (!alive) return
      denied = true
      setReady(false)
      setSaved('')
      setStatus(dirty ? 'Unsynced' : 'Read-only')
      setError(reason)
      refresh()
    }
    const provider = new HocuspocusProvider({
      url,
      name: room,
      document: doc,
      flushDelay: 35,
      onStatus({ status }) {
        if (!alive || denied) return
        connected = status === 'connected'
        if (connected) setStatus('Connected')
        else {
          synchronized = false
          durableHash = ''
          setSaved('')
          setStatus(dirty ? 'Unsynced' : previouslySynced ? 'Reconnecting' : 'Connecting')
        }
      },
      onSynced({ state }) {
        if (!alive || denied) return
        synchronized = state
        if (state) {
          previouslySynced = true
          setReady(true)
          if (!writable) setStatus('Read-only')
          void verify()
        }
      },
      onAuthenticationFailed() {
        blocked('Document access changed. Reload the record to check your access.')
      },
      onClose({ event }) {
        if (event.code === 4403 || event.reason === documentAccessChanged)
          blocked('The document session ended because access or the active revision changed.')
        else if (event.code === 4400 || event.reason === invalidDocumentUpdate)
          blocked(
            'The server rejected a document edit. Reopen the document to load the saved revision.',
          )
      },
    })
    const changed = (_update: Uint8Array, source: unknown) => {
      if (!alive || denied || !writable) return
      generation++
      lastUpdate = Date.now()
      if (source !== provider) {
        dirty = true
        pending(tabKey, true)
      }
      setSaved('')
      setStatus(connected ? 'Saving' : 'Unsynced')
    }
    doc.on('update', changed)
    // The provider is an external resource with an effect-owned lifetime.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConnection({ doc, provider })

    async function verify() {
      if (!alive || checking || denied || !connected || !synchronized || !writable) return
      if (durableHash && !dirty && Date.now() - lastUpdate > 4000) return
      checking = true
      const captured = generation
      try {
        const [remote, local] = await Promise.all([
          api<Durable>('/documents/' + id + '/durable'),
          stateDigest(doc),
        ])
        if (!alive || !connected || denied || captured !== generation) return
        if (remote.epoch !== epoch) {
          blocked('The active document revision changed.')
          return
        }
        if (remote.failed) {
          setStatus('Unsynced')
          setError(
            'The database has not confirmed these edits. Leave this tab open while the server retries.',
          )
        } else if (remote.stateHash === local) {
          durableHash = local
          dirty = false
          pending(tabKey, false)
          setError('')
          setSaved(local)
          setStatus('Saved')
        } else {
          durableHash = ''
          setStatus('Saving')
        }
      } catch {
        if (alive && !denied) {
          setSaved('')
          setStatus(dirty ? 'Unsynced' : 'Reconnecting')
          refresh()
        }
      } finally {
        checking = false
      }
    }
    const timer = setInterval(() => {
      void verify()
    }, 650)
    return () => {
      alive = false
      clearInterval(timer)
      pending(tabKey, false)
      doc.off('update', changed)
      provider.destroy()
      doc.destroy()
    }
  }, [id, epoch, writable, pending, refresh, tabKey])
  return { connection, status, saved, ready, error }
}

function RichEditor({
  connection,
  ready,
  writable,
  hosts,
  title,
}: {
  connection: Connection
  ready: boolean
  writable: boolean
  hosts: string[]
  title: string
}) {
  const { user } = useSession()
  const [insert, setInsert] = useState<'link' | 'image' | null>(null)
  const [initialHosts] = useState(hosts)
  const extensions = useMemo(
    () => [
      ...richTextExtensions(initialHosts),
      Collaboration.configure({ document: connection.doc, field: documentField }),
      CollaborationCaret.configure({
        provider: connection.provider,
        user: { name: user.displayName, color: '#e3bc78' },
      }),
    ],
    [connection, initialHosts, user.displayName],
  )
  const editor = useEditor(
    {
      extensions,
      editable: false,
      editorProps: {
        attributes: { 'aria-label': title + ' editor', role: 'textbox', 'aria-multiline': 'true' },
      },
    },
    [extensions],
  )
  useEffect(() => {
    editor?.setEditable(ready && writable, false)
  }, [editor, ready, writable])
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold'),
      italic: editor?.isActive('italic'),
      underline: editor?.isActive('underline'),
      h2: editor?.isActive('heading', { level: 2 }),
      h3: editor?.isActive('heading', { level: 3 }),
      bullet: editor?.isActive('bulletList'),
      numbered: editor?.isActive('orderedList'),
      quote: editor?.isActive('blockquote'),
      table: editor?.isActive('table'),
    }),
  })
  if (!editor) return <Empty>Opening editor…</Empty>
  const tool = (text: string, run: () => boolean, pressed?: boolean) => (
    <button type="button" aria-pressed={pressed} onClick={run}>
      {text}
    </button>
  )
  return (
    <>
      {writable && (
        <fieldset className="editor-tools" aria-label="Formatting" disabled={!ready}>
          {tool('Undo', () => editor.commands.undo())}
          {tool('Redo', () => editor.commands.redo())}
          <span className="tool-divider" />
          {tool(
            'Heading',
            () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
            active?.h2 ?? false,
          )}
          {tool(
            'Subheading',
            () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
            active?.h3 ?? false,
          )}
          {tool('Paragraph', () => editor.chain().focus().setParagraph().run())}
          {tool('Bold', () => editor.chain().focus().toggleBold().run(), active?.bold ?? false)}
          {tool('Italic', () => editor.chain().focus().toggleItalic().run(), active?.italic ?? false)}
          {tool(
            'Underline',
            () => editor.chain().focus().toggleUnderline().run(),
            active?.underline ?? false,
          )}
          <span className="tool-divider" />
          {tool(
            'Bullets',
            () => editor.chain().focus().toggleBulletList().run(),
            active?.bullet ?? false,
          )}
          {tool(
            'Numbered list',
            () => editor.chain().focus().toggleOrderedList().run(),
            active?.numbered ?? false,
          )}
          {tool('Quote', () => editor.chain().focus().toggleBlockquote().run(), active?.quote ?? false)}
          {tool('Insert table', () =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
          )}
          {active?.table && (
            <>
              {tool('Add row', () => editor.chain().focus().addRowAfter().run())}
              {tool('Add column', () => editor.chain().focus().addColumnAfter().run())}
              {tool('Remove table', () => editor.chain().focus().deleteTable().run())}
            </>
          )}
          <button
            type="button"
            aria-expanded={insert === 'link'}
            onClick={() => setInsert(insert === 'link' ? null : 'link')}
          >
            Link
          </button>
          {editor.isActive('link') &&
            tool('Unlink', () => editor.chain().focus().extendMarkRange('link').unsetLink().run())}
          <button
            type="button"
            aria-expanded={insert === 'image'}
            onClick={() => setInsert(insert === 'image' ? null : 'image')}
          >
            Image URL
          </button>
        </fieldset>
      )}
      {insert && ready && writable && (
        <ActionForm
          key={insert}
          className="editor-insert"
          label={insert === 'image' ? 'Insert image' : 'Apply link'}
          onCancel={() => setInsert(null)}
          submit={async (form) => {
            const url = string(form, 'url')
            if (!safeHttps(url)) throw new Error('Enter an HTTPS URL without credentials.')
            if (insert === 'image') {
              if (!imageAllowed(url, hosts)) throw new Error('Use an image URL from an approved host.')
              editor
                .chain()
                .focus()
                .setImage({ src: url, alt: string(form, 'alt') })
                .run()
            } else {
              const label = string(form, 'label') || url
              if (editor.state.selection.empty)
                editor
                  .chain()
                  .focus()
                  .insertContent({
                    type: 'text',
                    text: label,
                    marks: [{ type: 'link', attrs: { href: url } }],
                  })
                  .run()
              else editor.chain().focus().setLink({ href: url }).run()
            }
            setInsert(null)
          }}
        >
          <Field label="HTTPS URL">
            <input name="url" type="url" required maxLength={4096} />
          </Field>
          {insert === 'image' ? (
            <Field label="Image description">
              <input name="alt" required maxLength={180} />
            </Field>
          ) : (
            <Field label="Link text">
              <input name="label" maxLength={180} />
            </Field>
          )}
        </ActionForm>
      )}
      <div className="paper">
        {!ready && (
          <p className="muted editor-loading" role="status">
            Waiting for the document to synchronize.
          </p>
        )}
        <EditorContent editor={editor} />
      </div>
    </>
  )
}

function Presence({ connection }: { connection: Connection }) {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    const awareness = connection.provider.awareness
    if (!awareness) return
    const update = () => {
      const peers = [...awareness.getStates()]
        .filter(([id]) => id !== connection.doc.clientID)
        .map(([, value]) => value.user)
        .filter((user) => typeof user?.id === 'string' && typeof user?.name === 'string')
      setNames([...new Map(peers.map((user) => [user.id, user.name as string])).values()])
    }
    awareness.on('change', update)
    update()
    return () => awareness.off('change', update)
  }, [connection])
  return (
    <span className="collaborators">
      {names.length ? 'Also here · ' + names.join(', ') : 'No other collaborators connected'}
    </span>
  )
}

function RevisionContent({ content, hosts }: { content: JSONContent; hosts: string[] }) {
  const editor = useEditor({ content, extensions: richTextExtensions(hosts), editable: false }, [
    content,
    hosts,
  ])
  return (
    <div className="paper revision-paper">
      <EditorContent editor={editor} />
    </div>
  )
}

function History({
  record,
  saved,
  run,
  hosts,
}: {
  record: DocumentRecord
  saved: string
  run: (action: string, detail?: Record<string, string>) => Promise<unknown>
  hosts: string[]
}) {
  const [page, setPage] = useState(1)
  const [selection, setSelection] = useState<Revision | null>(null)
  const [checkpoint, setCheckpoint] = useState(false)
  const base = '/documents/' + record.id + '/history'
  const revisions = useResource<Page<Revision>>(base + '?page=' + page)
  const preview = useResource<{ content: JSONContent }>(
    selection ? base + '/' + selection.id : null,
    false,
  )
  const date = useDate()
  return (
    <section className="surface padded doc-history">
      <div className="section-head">
        <h2>Revision history</h2>
        {record.writable && (
          <button
            onClick={() => setCheckpoint(!checkpoint)}
            disabled={!saved}
            aria-expanded={checkpoint}
          >
            Name checkpoint
          </button>
        )}
      </div>
      {checkpoint && record.writable && (
        <ActionForm
          label="Save checkpoint"
          onCancel={() => setCheckpoint(false)}
          success="Checkpoint saved."
          submit={async (form) => {
            await run('checkpoint', { label: string(form, 'label') })
            setCheckpoint(false)
          }}
        >
          <Field label="Checkpoint name">
            <input name="label" required maxLength={120} />
          </Field>
        </ActionForm>
      )}
      <ResourceView resource={revisions}>
        {(data) => (
          <>
            {data.items.length ? (
              <ul className="line-list">
                {data.items.map((revision) => (
                  <li key={revision.id}>
                    <div>
                      <button
                        className="text-button"
                        type="button"
                        aria-pressed={selection?.id === revision.id}
                        onClick={() => setSelection(revision)}
                      >
                        {revision.label}
                      </button>
                      <span className="minor">
                        {date(revision.createdAt)} · {revision.actor?.displayName ?? 'Autosave'}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No revisions have been recorded.</Empty>
            )}
            <Pager page={page} more={data.more} setPage={setPage} />
          </>
        )}
      </ResourceView>
      {selection && (
        <div className="revision-preview">
          <h3>{selection.label}</h3>
          <ResourceView resource={preview}>
            {(data) => <RevisionContent content={data.content} hosts={hosts} />}
          </ResourceView>
          {saved && record.writable && (
            <Confirm
              label="Restore revision"
              description="Preserve the current saved document in history and reopen this revision for connected editors. Edits that have not reached the server may be discarded."
              run={async () => {
                await run('restore', { revisionId: selection.id })
                setSelection(null)
              }}
            />
          )}
        </div>
      )}
    </section>
  )
}

function DocumentRoom({
  record,
  tabKey,
  hosts,
}: {
  record: DocumentRecord
  tabKey: string
  hosts: string[]
}) {
  const { connection, status, saved, ready, error } = useConnection(record, tabKey)
  const [history, setHistory] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const date = useDate()
  const notice = useNotice()
  const navigate = useNavigate()
  const path = '/documents/' + record.id
  async function revision(action: string, detail?: Record<string, string>) {
    if (!saved) throw new Error('Wait for the latest edits to be saved.')
    await api(path + '/history', {
      method: 'POST',
      data: { action, stateHash: saved, epoch: record.epoch, ...detail },
    })
    if (action === 'restore') notice('Document revision restored.')
  }
  const incident = record.type === 'INCIDENT'
  const amended =
    record.submitted &&
    (record.submitted.stateHash !== record.stateHash || status === 'Saving' || status === 'Unsynced')
  return (
    <div className="page document-page">
      <Link className="crumb" title={record.case.title} to={'/cases/' + record.case.id}>
        {record.case.number} · {record.case.title}
      </Link>
      <PageHead
        title={record.title}
        kicker={incident ? undefined : labels[record.type]}
        detail={
          <>
            {record.category && <span>{record.category}</span>}
            <span>Opened by {record.author.displayName}</span>
            {incident && (
              <span className="state">
                {amended
                  ? 'Amended · pending review'
                  : record.submitted
                    ? 'Submitted ' + date(record.submitted.createdAt)
                    : 'Working draft'}
              </span>
            )}
          </>
        }
        actions={
          <>
            {incident &&
              record.writable &&
              (saved ? (
                <AsyncButton
                  className="primary"
                  run={() => revision('submit')}
                  success="Incident report submitted."
                >
                  {record.submitted ? 'Submit amendment' : 'Submit report'}
                </AsyncButton>
              ) : (
                <button type="button" disabled>
                  {record.submitted ? 'Submit amendment' : 'Submit report'}
                </button>
              ))}
            <button onClick={() => setHistory(!history)} aria-expanded={history}>
              Revision history
            </button>
            {!incident && record.writable && (
              <button onClick={() => setEditing(record.version)}>Edit document details</button>
            )}
            {!incident && record.writable && !!saved && (
              <Confirm
                label="Remove document"
                description="Remove this supporting document from the case. Its stored history is retained."
                run={async () => {
                  await remove(path, { version: record.version })
                  navigate('/cases/' + record.case.id)
                }}
              />
            )}
          </>
        }
      />
      {editing !== null && record.writable && (
        <section className="surface padded">
          <ActionForm
            onCancel={() => setEditing(null)}
            success="Document details saved."
            submit={async (form) => {
              await api(path, {
                method: 'PATCH',
                data: {
                  title: string(form, 'title'),
                  category: string(form, 'category'),
                  version: editing,
                },
              })
              setEditing(null)
            }}
          >
            <div className="form-grid">
              <Field label="Document title">
                <input name="title" required maxLength={180} defaultValue={record.title} />
              </Field>
              <Field label="Category">
                <input name="category" maxLength={100} defaultValue={record.category} />
              </Field>
            </div>
          </ActionForm>
        </section>
      )}
      <div className="document-frame">
        <div className="document-status">
          <span
            role="status"
            className={
              'save-state ' + (status === 'Saved' ? 'online' : status === 'Unsynced' ? 'offline' : '')
            }
          >
            {status}
          </span>
          {connection && <Presence connection={connection} />}
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {connection ? (
          <RichEditor
            connection={connection}
            ready={ready}
            writable={record.writable}
            hosts={hosts}
            title={record.title}
          />
        ) : (
          <Empty>Opening document…</Empty>
        )}
      </div>
      {history && <History record={record} saved={saved} run={revision} hosts={hosts} />}
    </div>
  )
}

export function DocumentPage({ record, tabKey }: { record: DocumentRecord; tabKey: string }) {
  const catalog = useCatalog()
  return (
    <ResourceView resource={catalog}>
      {(data) => (
        <DocumentRoom
          record={record}
          tabKey={tabKey}
          hosts={data.hosts}
          key={record.id + '.' + record.epoch + '.' + record.writable}
        />
      )}
    </ResourceView>
  )
}

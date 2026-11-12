import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, selected } from './api.js'
import { useDate, useResource } from './state.js'
import { Empty, ActionForm, PageHead, ResourceView } from './ui.js'
import type { CaseRecord, Packet } from './types.js'
import { labels, safeHttps } from '../../../packages/shared/validation.js'

function download(packet: Packet) {
  const blob = new Blob([JSON.stringify(packet, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = packet.case.number + '.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function PacketPage({ caseId }: { caseId: string }) {
  const record = useResource<CaseRecord>('/cases/' + caseId)
  const [packet, setPacket] = useState<Packet | null>(null)
  const date = useDate()
  return (
    <div className="page reading packet">
      <div className="no-print">
        <Link className="crumb" to={'/cases/' + caseId}>
          Return to case
        </Link>
        <PageHead
          title="Case packet"
          detail="Choose the sections to include in a printable copy or JSON export."
        />
        <ResourceView resource={record}>
          {(data) => (
            <section className="surface padded">
              <ActionForm
                label="Prepare packet"
                submit={async (form) =>
                  setPacket(
                    await api<Packet>('/cases/' + caseId + '/export', {
                      method: 'POST',
                      data: {
                        documents: selected(form, 'documents'),
                        evidence: form.has('evidence'),
                        tasks: form.has('tasks'),
                      },
                    }),
                  )
                }
              >
                <div className="check-group">
                  <h2>Documents</h2>
                  {data.documents.map((doc) => (
                    <label className="check" key={doc.id}>
                      <input
                        type="checkbox"
                        name="documents"
                        value={doc.id}
                        defaultChecked={doc.type === 'INCIDENT'}
                      />
                      {doc.title}
                    </label>
                  ))}
                  <h2>Other sections</h2>
                  <label className="check">
                    <input type="checkbox" name="evidence" defaultChecked />
                    Evidence references
                  </label>
                  <label className="check">
                    <input type="checkbox" name="tasks" defaultChecked />
                    Case tasks
                  </label>
                </div>
              </ActionForm>
            </section>
          )}
        </ResourceView>
        {record.value && packet && (
          <div className="actions packet-actions">
            <button className="primary" onClick={() => window.print()}>
              Print or save as PDF
            </button>
            <button onClick={() => download(packet)}>Download JSON</button>
          </div>
        )}
      </div>
      {packet && record.value ? (
        <article className="packet-content">
          <PageHead
            title={packet.case.title}
            kicker={packet.case.number}
            detail={'Prepared ' + date(packet.exportedAt)}
          />
          <p>
            {packet.case.status.label} · {labels[packet.case.priority]} priority
            {packet.case.restricted && ' · Restricted'}
          </p>
          <p className="preserve prose">{packet.case.summary}</p>
          {!!packet.case.persons.length && (
            <section>
              <h2>People</h2>
              <ul>
                {packet.case.persons.map((item) => (
                  <li key={item.id}>
                    {item.name} · {labels[item.role]}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {packet.documents.map((doc) => (
            <section key={doc.id}>
              <h2>{doc.title}</h2>
              {doc.amended && <p>Working copy · amendments pending review</p>}
              <p className="preserve prose">{doc.plainText || 'No text recorded.'}</p>
              {doc.amended && doc.submitted && (
                <>
                  <h3>Last submitted revision · {date(doc.submitted.createdAt)}</h3>
                  <p className="preserve prose">{doc.submitted.plainText}</p>
                </>
              )}
            </section>
          ))}
          {!!packet.evidence.length && (
            <section>
              <h2>Evidence references</h2>
              <ol>
                {packet.evidence.map((item) => (
                  <li key={item.id}>
                    <strong>
                      E-{String(item.reference).padStart(3, '0')} · {item.title}
                    </strong>
                    <p className="preserve">{item.description}</p>
                    {item.sourceUrl && safeHttps(item.sourceUrl) && (
                      <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
                        {item.sourceUrl}
                      </a>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {!!packet.tasks.length && (
            <section>
              <h2>Tasks</h2>
              <ul>
                {packet.tasks.map((item) => (
                  <li key={item.id}>
                    {item.description} · {labels[item.status]}
                    {item.dueAt && ' · Due ' + date(item.dueAt)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      ) : (
        <div className="no-print">
          <Empty>Prepare the case packet to preview it here.</Empty>
        </div>
      )}
    </div>
  )
}

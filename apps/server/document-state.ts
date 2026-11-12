import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { Node } from '@tiptap/pm/model'
import { documentField, reportSchema, starterDocument } from '../../packages/shared/rich-text.js'
import { imageAllowed, safeHttps } from '../../packages/shared/validation.js'
import { digest } from './password.js'
import { durabilityProof } from '../../packages/shared/durability.js'

export const maxDocumentBytes = 2 * 1024 * 1024

function previousImages(doc: Y.Doc) {
  const root = Node.fromJSON(reportSchema, yDocToProsemirrorJSON(doc, documentField))
  const counts = new Map<string, number>()
  root.descendants((node) => {
    const src: unknown = node.attrs.src
    if (node.type.name === 'image' && typeof src === 'string')
      counts.set(src, (counts.get(src) ?? 0) + 1)
    return true
  })
  return counts
}

export function readDocument(doc: Y.Doc, imagePolicy?: { hosts: string[]; previous: Y.Doc }) {
  const state = new Uint8Array(Y.encodeStateAsUpdate(doc))
  const stateHash = digest(durabilityProof(doc))
  if (state.byteLength > maxDocumentBytes) throw new Error('Document exceeds the storage limit.')
  if (doc.share.size > 1 || [...doc.share.keys()].some((key) => key !== documentField)) {
    throw new Error('Invalid document fields.')
  }
  const json = yDocToProsemirrorJSON(doc, documentField)
  const root = Node.fromJSON(reportSchema, json)
  if (!root.childCount)
    return { state, stateHash, plainText: '', narrativeText: '', json: starterDocument([]) }
  root.check()
  const prose: string[] = []
  let retiredSources: Map<string, number> | undefined
  let count = 0
  root.descendants((node) => {
    if (++count > 25000) throw new Error('Document exceeds the content limit.')
    if (node.type.name === 'paragraph' && node.textContent.trim()) prose.push(node.textContent.trim())
    if (node.type.name === 'image') {
      const src: unknown = node.attrs.src
      if (typeof src !== 'string' || !safeHttps(src)) throw new Error('Document image URL is invalid.')
      if (imagePolicy && !imageAllowed(src, imagePolicy.hosts)) {
        // Retain references already in the document when a host is removed from the allowlist.
        retiredSources ??= previousImages(imagePolicy.previous)
        const retained = retiredSources.get(src) ?? 0
        if (!retained) throw new Error('Document image host is not approved.')
        retiredSources.set(src, retained - 1)
      }
    }
    if (
      node.marks.some(
        (mark) =>
          mark.type.name === 'link' &&
          (typeof mark.attrs.href !== 'string' || !safeHttps(mark.attrs.href)),
      )
    ) {
      throw new Error('Document contains an invalid link.')
    }
    return true
  })
  return {
    state,
    stateHash,
    plainText: root.textBetween(0, root.content.size, '\n'),
    narrativeText: prose.join('\n'),
    json,
  }
}

export function initialDocument(headings: string[]) {
  const doc = prosemirrorJSONToYDoc(reportSchema, starterDocument(headings), documentField)
  try {
    const { json: _json, ...data } = readDocument(doc)
    return data
  } finally {
    doc.destroy()
  }
}

export function decodeDocument(state: Uint8Array) {
  const doc = new Y.Doc()
  try {
    doc.getXmlFragment(documentField)
    Y.applyUpdate(doc, state)
    return readDocument(doc).json
  } finally {
    doc.destroy()
  }
}

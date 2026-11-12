import * as Y from 'yjs'

export const documentAccessChanged = 'Document access changed'
export const invalidDocumentUpdate = 'Invalid or oversized document update'

// Replicas can retain different payloads for deleted items while sharing all
// operations. The snapshot encodes both operation clocks and the deletion set.
export function durabilityProof(doc: Y.Doc): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Y.encodeSnapshot(Y.snapshot(doc)))
}

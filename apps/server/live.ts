import { EventEmitter } from 'node:events'

export type Change = {
  caseId?: string
  documentId?: string
  userId?: string
  sessionId?: string
  disconnect?: boolean
}
const events = new EventEmitter()
events.setMaxListeners(0)

export function publish(change: Change = {}) {
  events.emit('change', change)
}
export function subscribe(listener: (change: Change) => void) {
  events.on('change', listener)
  return () => events.off('change', listener)
}

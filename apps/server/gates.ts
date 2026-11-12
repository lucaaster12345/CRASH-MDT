// Serializes document input and lifecycle transitions for one case on this instance.
const gates = new Map<string, Promise<void>>()

export async function enterCaseGate(caseId: string) {
  const previous = gates.get(caseId)
  let unlock!: () => void
  const current = new Promise<void>((resolve) => {
    unlock = resolve
  })
  gates.set(caseId, current)
  await previous
  return () => {
    if (gates.get(caseId) === current) gates.delete(caseId)
    unlock()
  }
}

export async function inCaseGate<T>(caseId: string, work: () => Promise<T>) {
  const release = await enterCaseGate(caseId)
  try {
    return await work()
  } finally {
    release()
  }
}

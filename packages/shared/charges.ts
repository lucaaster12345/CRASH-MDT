export type ChargeLine = {
  chargeId: string
  code: string
  title: string
  custodyMinutes: number
  fineCents: number
  count: number
}

export type SuspectChargeSummary = {
  personId: string
  name: string
  charges: ChargeLine[]
  custodyMinutes: number
  fineCents: number
}

export function chargeTotals(charges: readonly ChargeLine[]) {
  return charges.reduce(
    (total, line) => ({
      custodyMinutes: total.custodyMinutes + line.custodyMinutes * line.count,
      fineCents: total.fineCents + line.fineCents * line.count,
    }),
    { custodyMinutes: 0, fineCents: 0 },
  )
}

export function formatFine(cents: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

export function formatCustody(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours
    ? [hours + ' hr', remainder ? remainder + ' min' : ''].filter(Boolean).join(' ')
    : minutes + ' min'
}

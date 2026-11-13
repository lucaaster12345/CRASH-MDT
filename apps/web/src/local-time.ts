export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function localDateTimeValue(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

export function localDateTimeToIso(value: string, original?: string | null) {
  if (original && localDateTimeValue(original) === value) return original
  const date = new Date(value)
  if (
    localDateTimeValue(Number.isNaN(date.getTime()) ? null : date.toISOString()) !== value ||
    !value
  ) {
    throw new Error('Enter a valid local date and time. Some times are skipped when clocks change.')
  }
  return date.toISOString()
}

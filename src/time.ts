const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string) {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, value)
  }
  return value
}

export function isValidTimeZone(timeZone: string) {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function localParts(epochMs: number, timeZone: string) {
  const parts: Record<string, string> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    parts[part.type] = part.value
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    seconds: Number(parts.second),
  }
}

function offsetAt(epochMs: number, timeZone: string) {
  const { date, minutes, seconds } = localParts(epochMs, timeZone)
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day, 0, minutes, seconds) - Math.floor(epochMs / 1000) * 1000
}

export function localToEpoch(date: string, minutes: number, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number)
  const wall = Date.UTC(year, month - 1, day, 0, minutes)
  const guess = wall - offsetAt(wall, timeZone)
  return wall - offsetAt(guess, timeZone)
}

export function toApiDate(epochMs: number) {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export function weekday(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

export function formatDay(date: string) {
  const [, month, day] = date.split('-')
  return `${WEEKDAYS[weekday(date)]} ${day}/${month}`
}

export function formatClock(minutes: number) {
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0')
  return `${hours}:${String(minutes % 60).padStart(2, '0')}`
}

export function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest}m`
  return rest ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${hours}h`
}

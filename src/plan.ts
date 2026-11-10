import type { EntryRow } from './input.ts'
import { normalize } from './text.ts'

export type Interval = { start: number; end: number }

export type ExistingEntry = Interval & {
  date: string
  description: string
  projectId: string | null
}

export type Target = {
  row: EntryRow
  date: string
  description: string
  projectId: string | null
  projectName: string | null
  taskName?: string | null
  taskId: string | null
  tagIds: string[]
  billable: boolean | null
}

export type PlanStatus = 'nueva' | 'existe' | 'solapa' | 'no-cabe'

export type PlanItem = Target & {
  status: PlanStatus
  minutes: number
  alreadyLogged: number
  blocks: Interval[]
}

export type PlanOptions = {
  dayStart: number
  lunch: Interval | null
  allowOverlap: boolean
}

export const DAY_MINUTES = 24 * 60

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end

const entryKey = (description: string, projectId: string | null) =>
  `${normalize(description)}|${projectId ?? ''}`

function fill(minutes: number, from: number, busy: Interval[]) {
  const blocks: Interval[] = []
  let cursor = from
  let remaining = minutes
  while (remaining > 0) {
    if (cursor >= DAY_MINUTES) return null
    const blocking = busy.find((interval) => interval.start <= cursor && cursor < interval.end)
    if (blocking) {
      cursor = blocking.end
      continue
    }
    const nextBusy = Math.min(
      DAY_MINUTES,
      ...busy.filter((interval) => interval.start > cursor).map((interval) => interval.start),
    )
    const end = Math.min(nextBusy, cursor + remaining)
    blocks.push({ start: cursor, end })
    remaining -= end - cursor
    cursor = end
  }
  return blocks
}

export function buildPlan(targets: Target[], existing: ExistingEntry[], options: PlanOptions) {
  const items: PlanItem[] = targets.map((target) => ({
    ...target,
    status: 'nueva',
    minutes: target.row.minutes,
    alreadyLogged: 0,
    blocks: [],
  }))

  for (const date of [...new Set(items.map((item) => item.date))].sort()) {
    const dayItems = items.filter((item) => item.date === date)
    const dayEntries = existing.filter((entry) => entry.date === date && entry.end > entry.start)
    const occupied: Interval[] = dayEntries.map(({ start, end }) => ({ start, end }))

    const logged = new Map<string, number>()
    for (const entry of dayEntries) {
      const key = entryKey(entry.description, entry.projectId)
      logged.set(key, (logged.get(key) ?? 0) + entry.end - entry.start)
    }
    for (const item of dayItems) {
      const key = entryKey(item.description, item.projectId)
      const available = logged.get(key) ?? 0
      const consumed = item.row.start === null || available >= item.minutes ? Math.min(available, item.minutes) : 0
      if (!consumed) continue
      logged.set(key, available - consumed)
      item.alreadyLogged = consumed
      item.minutes -= consumed
      if (!item.minutes) item.status = 'existe'
    }

    for (const item of dayItems) {
      if (item.status !== 'nueva' || item.row.start === null) continue
      const block = { start: item.row.start, end: item.row.start + item.minutes }
      item.blocks = [block]
      if (block.end > DAY_MINUTES) item.status = 'no-cabe'
      else if (!options.allowOverlap && occupied.some((other) => overlaps(block, other))) item.status = 'solapa'
      else occupied.push(block)
    }

    for (const item of dayItems) {
      if (item.status !== 'nueva' || item.row.start !== null) continue
      const busy = options.lunch ? [...occupied, options.lunch] : occupied
      const blocks = fill(item.minutes, options.dayStart, busy)
      if (blocks) {
        item.blocks = blocks
        occupied.push(...blocks)
      } else {
        item.status = 'no-cabe'
      }
    }
  }

  return items
}

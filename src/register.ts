import { stdin } from 'node:process'
import { ClockifyError, createClient, type Client, type Project, type Tag, type TimeEntry } from './clockify.ts'
import { parseClock, readEntries, type EntryRow } from './input.ts'
import { buildPlan, DAY_MINUTES, type ExistingEntry, type Interval, type PlanItem, type Target } from './plan.ts'
import { confirm } from './prompt.ts'
import { requireSession, type Session } from './session.ts'
import { normalize } from './text.ts'
import {
  addDays,
  formatClock,
  formatDay,
  formatDuration,
  localParts,
  localToEpoch,
  toApiDate,
} from './time.ts'

export type RegisterOptions = {
  dryRun: boolean
  yes: boolean
  allowOverlap: boolean
  lunch: Interval | null
  dayStart: number | null
  timeZone: string | null
  today?: string
}

const STATUS_LABELS: Record<PlanItem['status'], string> = {
  nueva: 'nueva',
  existe: 'ya está en Clockify',
  solapa: 'choca con otra entrada',
  'no-cabe': 'no cabe en el día',
}

function findByName<T extends { name: string }>(items: T[], name: string) {
  const wanted = normalize(name)
  const exact = items.filter((item) => normalize(item.name) === wanted)
  if (exact.length) return exact
  return items.filter((item) => normalize(item.name).includes(wanted))
}

function pickOne<T extends { name: string }>(items: T[], name: string, kind: string) {
  const matches = findByName(items, name)
  if (matches.length === 1) return matches[0]
  if (!matches.length) return `no encontré ${kind} «${name}».`
  const names = matches.slice(0, 5).map((item) => `«${item.name}»`)
  return `«${name}» coincide con varios ${kind}s: ${names.join(', ')}. Escribe el nombre completo.`
}

async function resolveTargets(rows: EntryRow[], session: Session, client: Client) {
  const workspaceId = session.workspace.id
  const errors: string[] = []
  const projects: Project[] = rows.some((row) => row.project) ? await client.listProjects(workspaceId) : []
  const tags: Tag[] = rows.some((row) => row.tags.length) ? await client.listTags(workspaceId) : []
  const tasksCache = new Map<string, string>()
  const targets: Target[] = []

  for (const row of rows) {
    const fail = (message: string) => errors.push(`${row.label}: ${message}`)
    let project = session.defaultProject
    if (row.project) {
      const match = pickOne(projects, row.project, 'el proyecto')
      if (typeof match === 'string') {
        fail(match)
        continue
      }
      project = { id: match.id, name: match.name }
    }

    let taskId: string | null = null
    if (row.task && !project) {
      fail('para usar «tarea» indica el «proyecto» o elige uno por defecto en el login.')
      continue
    }
    if (row.task && project) {
      const key = `${project.id}|${normalize(row.task)}`
      const cached = tasksCache.get(key)
      if (cached) {
        taskId = cached
      } else {
        const match = pickOne(await client.findTasks(workspaceId, project.id, row.task), row.task, 'la tarea')
        if (typeof match === 'string') {
          fail(`${match} (proyecto «${project.name}»)`)
          continue
        }
        taskId = match.id
        tasksCache.set(key, taskId)
      }
    }

    const tagIds: string[] = []
    for (const tagName of row.tags) {
      const match = pickOne(tags, tagName, 'la etiqueta')
      if (typeof match === 'string') fail(match)
      else tagIds.push(match.id)
    }

    const description = row.note ? `${row.ticket} — ${row.note}` : row.ticket
    for (const date of row.dates) {
      targets.push({
        row,
        date,
        description,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        taskId,
        tagIds,
        billable: row.billable,
      })
    }
  }
  return { targets, errors }
}

function toExisting(entries: TimeEntry[], timeZone: string, now: number) {
  return entries.flatMap((entry): ExistingEntry[] => {
    const startMs = Date.parse(entry.timeInterval.start)
    const endMs = entry.timeInterval.end ? Date.parse(entry.timeInterval.end) : now
    const start = localParts(startMs, timeZone)
    const end = localParts(endMs, timeZone)
    const base = { description: entry.description ?? '', projectId: entry.projectId ?? null }
    if (start.date === end.date) return [{ ...base, date: start.date, start: start.minutes, end: end.minutes }]
    return [
      { ...base, date: start.date, start: start.minutes, end: DAY_MINUTES },
      { ...base, date: end.date, start: 0, end: end.minutes },
    ]
  })
}

function truncate(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function printPlan(plan: PlanItem[], existing: ExistingEntry[]) {
  const header = ['Fecha', 'Horario', 'Horas', 'Ticket', 'Proyecto', 'Estado']
  const lines: string[][] = []
  const dates = [...new Set(plan.map((item) => item.date))].sort()
  for (const date of dates) {
    for (const item of plan.filter((candidate) => candidate.date === date)) {
      const status =
        item.status === 'nueva' && item.alreadyLogged
          ? `nueva (ya había ${formatDuration(item.alreadyLogged)})`
          : STATUS_LABELS[item.status]
      lines.push([
        formatDay(date),
        item.blocks.map((block) => `${formatClock(block.start)}–${formatClock(block.end)}`).join(', ') || '—',
        formatDuration(item.status === 'existe' ? item.alreadyLogged : item.minutes),
        truncate(item.description, 48),
        truncate(item.projectName ?? '—', 24),
        status,
      ])
    }
    const logged = existing
      .filter((entry) => entry.date === date)
      .reduce((total, entry) => total + entry.end - entry.start, 0)
    const added = plan
      .filter((item) => item.date === date && item.status === 'nueva')
      .reduce((total, item) => total + item.minutes, 0)
    lines.push(['', '', formatDuration(logged + added), `total del ${formatDay(date)}`, '', ''])
  }
  const widths = header.map((title, column) => Math.max(title.length, ...lines.map((line) => line[column].length)))
  const render = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()
  console.log(`\n${render(header)}`)
  console.log(widths.map((width) => '─'.repeat(width)).join('  '))
  for (const line of lines) console.log(render(line))
}

export async function reviewPlan(
  plan: PlanItem[],
  existing: ExistingEntry[],
  options: Pick<RegisterOptions, 'dryRun' | 'yes'>,
) {
  printPlan(plan, existing)

  const blocked = plan.filter((item) => item.status === 'solapa' || item.status === 'no-cabe')
  if (blocked.length) {
    const hint = blocked.some((item) => item.status === 'solapa')
      ? ' Cambia la hora de inicio, quítala para que se acomode sola, o usa --permitir-solapes.'
      : ''
    throw new Error(`Hay ${blocked.length} fila(s) que no puedo acomodar; no envié nada.${hint}`)
  }

  const pending = plan.filter((item) => item.status === 'nueva')
  const entryCount = pending.reduce((total, item) => total + item.blocks.length, 0)
  if (!entryCount) {
    console.log('\nNo hay nada nuevo que registrar.')
    return null
  }
  const totalMinutes = pending.reduce((total, item) => total + item.minutes, 0)
  if (options.dryRun) {
    console.log(`\nModo prueba: se crearían ${entryCount} entradas (${formatDuration(totalMinutes)}). No envié nada.`)
    return null
  }
  if (!options.yes) {
    if (!stdin.isTTY) throw new Error('Agrega --si para confirmar sin preguntar.')
    if (!(await confirm(`\n¿Registrar ${entryCount} entradas (${formatDuration(totalMinutes)}) en Clockify?`))) {
      console.log('Cancelado; no envié nada.')
      return null
    }
  }
  return { pending, entryCount }
}

export async function register(file: string, options: RegisterOptions) {
  const session = await requireSession()
  const timeZone = options.timeZone ?? session.timeZone
  const now = Date.now()
  const today = options.today ?? localParts(now, timeZone).date

  const { rows, errors } = await readEntries(file, today)
  if (errors.length) throw new Error(`Revisa el archivo:\n  ${errors.join('\n  ')}`)

  const client = createClient(session.apiKey, session.baseUrl)
  const resolved = await resolveTargets(rows, session, client)
  if (resolved.errors.length) throw new Error(`Revisa el archivo:\n  ${resolved.errors.join('\n  ')}`)

  const dates = [...new Set(resolved.targets.map((target) => target.date))].sort()
  const entries = await client.listTimeEntries(
    session.workspace.id,
    session.user.id,
    toApiDate(localToEpoch(dates[0], 0, timeZone)),
    toApiDate(localToEpoch(addDays(dates[dates.length - 1], 1), 0, timeZone)),
  )
  const existing = toExisting(entries, timeZone, now)
  const plan = buildPlan(resolved.targets, existing, {
    dayStart: options.dayStart ?? parseClock(session.dayStart) ?? 9 * 60,
    lunch: options.lunch,
    allowOverlap: options.allowOverlap,
  })

  console.log(`Workspace: ${session.workspace.name} · zona horaria: ${timeZone}`)
  const review = await reviewPlan(plan, existing, options)
  if (!review) return { created: 0 }
  const { pending, entryCount } = review

  let created = 0
  const failures: string[] = []
  for (const item of pending) {
    for (const block of item.blocks) {
      try {
        await client.createTimeEntry(session.workspace.id, {
          start: toApiDate(localToEpoch(item.date, block.start, timeZone)),
          end: toApiDate(localToEpoch(item.date, block.end, timeZone)),
          description: item.description,
          ...(item.projectId ? { projectId: item.projectId } : {}),
          ...(item.taskId ? { taskId: item.taskId } : {}),
          ...(item.tagIds.length ? { tagIds: item.tagIds } : {}),
          ...(item.billable === null ? {} : { billable: item.billable }),
        })
        created++
      } catch (error) {
        if (error instanceof ClockifyError && (error.status === 401 || error.status === 429)) {
          console.log(`\nSe registraron ${created} de ${entryCount} entradas antes del error.`)
          throw error
        }
        failures.push(`${item.row.label} (${formatDay(item.date)}): ${(error as Error).message}`)
      }
    }
  }

  console.log(`\nListo: se registraron ${created} de ${entryCount} entradas.`)
  if (failures.length) {
    throw new Error(`Fallaron ${failures.length} entrada(s):\n  ${failures.join('\n  ')}`)
  }
  return { created }
}

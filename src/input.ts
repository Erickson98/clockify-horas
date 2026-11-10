import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { normalize } from './text.ts'
import { addDays, weekday } from './time.ts'

export type EntryRow = {
  label: string
  dates: string[]
  ticket: string
  minutes: number
  start: number | null
  project: string | null
  note: string | null
  task: string | null
  tags: string[]
  billable: boolean | null
}

const COLUMNS = {
  fecha: ['fecha', 'fechas', 'dia', 'date'],
  ticket: ['ticket', 'nombre', 'name'],
  horas: ['horas', 'duracion', 'tiempo', 'hours'],
  inicio: ['inicio', 'hora inicio', 'hora de inicio', 'desde', 'start'],
  proyecto: ['proyecto', 'project'],
  descripcion: ['descripcion', 'detalle', 'nota', 'description'],
  tarea: ['tarea', 'task'],
  etiquetas: ['etiquetas', 'etiqueta', 'tags', 'tag'],
  facturable: ['facturable', 'billable'],
}

type Column = keyof typeof COLUMNS

const REQUIRED: Column[] = ['fecha', 'ticket', 'horas']

const ALIASES = new Map<string, Column>(
  Object.entries(COLUMNS).flatMap(([column, aliases]) =>
    aliases.map((alias) => [alias, column as Column] as const),
  ),
)

const MAX_RANGE_DAYS = 62

type RawRecord = { label: string; values: Partial<Record<Column, string>> }

export function parseCsv(text: string) {
  const source = text.replace(/^﻿/, '')
  const delimiter = detectDelimiter(source.slice(0, source.search(/\r?\n|$/)))
  const rows: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowLine = 1

  const endRow = () => {
    cells.push(field)
    rows.push({ line: rowLine, cells })
    cells = []
    field = ''
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        if (char === '\n') line++
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      cells.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++
      endRow()
      line++
      rowLine = line
    } else {
      field += char
    }
  }
  if (field !== '' || cells.length) endRow()
  return rows
}

function detectDelimiter(header: string) {
  const counts = [';', ',', '\t'].map((candidate) => ({
    candidate,
    count: header.split(candidate).length - 1,
  }))
  counts.sort((a, b) => b.count - a.count)
  return counts[0].count > 0 ? counts[0].candidate : ','
}

export function parseDuration(value: string) {
  const compact = normalize(value).replace(/\s+/g, '')
  let match = compact.match(/^(\d+)(?::|h)(\d{1,2})m?$/)
  if (match) {
    const minutes = Number(match[2])
    return minutes < 60 ? Number(match[1]) * 60 + minutes : null
  }
  match = compact.match(/^(\d+(?:[.,]\d+)?)h?$/)
  if (match) return Math.round(Number(match[1].replace(',', '.')) * 60)
  match = compact.match(/^(\d+)m(?:in)?$/)
  if (match) return Number(match[1])
  return null
}

export function parseClock(value: string) {
  const match = normalize(value)
    .replace(/\s+/g, '')
    .match(/^(\d{1,2})(?::(\d{2}))?(a\.?m\.?|p\.?m\.?)?$/)
  if (!match) return null
  let hours = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  const suffix = match[3]?.[0]
  if (minutes > 59) return null
  if (suffix) {
    if (hours < 1 || hours > 12) return null
    hours = (hours % 12) + (suffix === 'p' ? 12 : 0)
  } else if (hours > 23) {
    return null
  }
  return hours * 60 + minutes
}

function parseDay(value: string) {
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  const parts = match
    ? [match[1], match[2], match[3]]
    : (match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))
      ? [match[3], match[2], match[1]]
      : null
  if (!parts) return null
  const [year, month, day] = parts.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null
  }
  return date.toISOString().slice(0, 10)
}

export function parseDates(value: string, today: string) {
  const text = normalize(value)
  if (text === 'hoy') return [today]
  if (text === 'ayer') return [addDays(today, -1)]
  const bounds = text.split(/\s*\.\.\s*|\s+(?:a|al|hasta)\s+/)
  if (bounds.length === 1) {
    const day = parseDay(text)
    return day ? [day] : null
  }
  if (bounds.length !== 2) return null
  const from = parseDay(bounds[0])
  const to = parseDay(bounds[1])
  if (!from || !to || to < from) return null
  const dates: string[] = []
  for (let day = from, count = 0; day <= to; day = addDays(day, 1), count++) {
    if (count >= MAX_RANGE_DAYS) return null
    if (weekday(day) !== 0 && weekday(day) !== 6) dates.push(day)
  }
  return dates.length ? dates : null
}

function parseBillable(value: string) {
  const text = normalize(value)
  if (!text) return null
  if (['si', 's', 'yes', 'y', 'true', '1', 'x'].includes(text)) return true
  if (['no', 'n', 'false', '0'].includes(text)) return false
  return undefined
}

function mapColumns(headers: string[], label: string): { columns: Column[]; errors: string[] } {
  const errors: string[] = []
  const columns = headers.map((header) => {
    const column = ALIASES.get(normalize(header))
    if (!column && header.trim()) {
      errors.push(
        `${label}: no conozco la columna «${header.trim()}». Usa: ${Object.keys(COLUMNS).join(', ')}.`,
      )
    }
    return column as Column
  })
  const missing = REQUIRED.filter((column) => !columns.includes(column))
  if (missing.length) errors.push(`Faltan las columnas: ${missing.join(', ')}.`)
  return { columns, errors }
}

function parseRecord(record: RawRecord, today: string, errors: string[]): EntryRow | null {
  const value = (column: Column) => record.values[column]?.trim() ?? ''
  const fail = (message: string) => errors.push(`${record.label}: ${message}`)
  const before = errors.length

  const ticket = value('ticket')
  if (!ticket) fail('falta el «ticket».')

  const dates = value('fecha') ? parseDates(value('fecha'), today) : null
  if (!value('fecha')) fail('falta la «fecha».')
  else if (!dates) {
    fail(
      `la fecha «${value('fecha')}» no es válida. Usa 2026-11-10, 10/11/2026, hoy, ayer o un rango 2026-11-10..2026-11-14.`,
    )
  }

  const minutes = value('horas') ? parseDuration(value('horas')) : null
  if (!value('horas')) fail('faltan las «horas».')
  else if (!minutes || minutes > 24 * 60) {
    fail(`las horas «${value('horas')}» no son válidas. Usa 2, 1.5, 1:30 o 45m.`)
  }

  const start = value('inicio') ? parseClock(value('inicio')) : null
  if (value('inicio') && start === null) {
    fail(`la hora de inicio «${value('inicio')}» no es válida. Usa 09:00, 14:30 o 2:30 pm.`)
  }

  const billable = parseBillable(value('facturable'))
  if (billable === undefined) fail(`«facturable» debe ser sí o no (recibí «${value('facturable')}»).`)

  if (errors.length > before) return null
  return {
    label: record.label,
    dates: dates!,
    ticket,
    minutes: minutes!,
    start,
    project: value('proyecto') || null,
    note: value('descripcion') || null,
    task: value('tarea') || null,
    tags: value('etiquetas')
      .split(/[|;,]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
    billable: billable ?? null,
  }
}

function recordsFromCsv(text: string, errors: string[]) {
  const rows = parseCsv(text).filter(
    ({ cells }) => cells.some((cell) => cell.trim()) && !cells[0].trim().startsWith('#'),
  )
  if (!rows.length) return []
  const [header, ...body] = rows
  const { columns, errors: headerErrors } = mapColumns(header.cells, `línea ${header.line}`)
  errors.push(...headerErrors)
  if (headerErrors.length) return []
  return body.map(({ line, cells }) => ({
    label: `línea ${line}`,
    values: Object.fromEntries(
      columns.flatMap((column, index) => (column ? [[column, cells[index] ?? '']] : [])),
    ),
  }))
}

function recordsFromJson(text: string, errors: string[]): RawRecord[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    errors.push(`El JSON no es válido: ${(error as Error).message}`)
    return []
  }
  if (!Array.isArray(data)) {
    errors.push('El JSON debe ser una lista de objetos.')
    return []
  }
  return data.flatMap((item, index) => {
    const label = `elemento ${index + 1}`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${label}: debe ser un objeto.`)
      return []
    }
    const entries = Object.entries(item as Record<string, unknown>)
    const { columns, errors: keyErrors } = mapColumns(
      entries.map(([key]) => key),
      label,
    )
    if (keyErrors.length) {
      errors.push(...keyErrors.filter((message) => !message.startsWith('Faltan')))
      if (keyErrors.some((message) => !message.startsWith('Faltan'))) return []
    }
    return [
      {
        label,
        values: Object.fromEntries(
          entries.flatMap(([, raw], position) => {
            const column = columns[position]
            if (!column || raw == null) return []
            return [[column, Array.isArray(raw) ? raw.join('|') : String(raw)]]
          }),
        ),
      },
    ]
  })
}

export async function readEntries(path: string, today: string) {
  const errors: string[] = []
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' ? `No encuentro el archivo ${path}.` : (error as Error).message)
  }
  const records =
    extname(path).toLowerCase() === '.json' ? recordsFromJson(text, errors) : recordsFromCsv(text, errors)
  const rows = records.flatMap((record) => parseRecord(record, today, errors) ?? [])
  if (!errors.length && !rows.length) errors.push('El archivo no tiene filas para registrar.')
  return { rows, errors }
}

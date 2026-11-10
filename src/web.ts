import type { Locator, Page } from 'playwright-core'
import { closeQuietly, openBrowser, openTracker } from './browser.ts'
import { parseClock, readEntries, type EntryRow } from './input.ts'
import { buildPlan, DAY_MINUTES, type ExistingEntry, type Interval, type PlanItem, type Target } from './plan.ts'
import { reviewPlan, type RegisterOptions } from './register.ts'
import { normalize } from './text.ts'
import { addDays, formatClock, formatDay, localParts, systemTimeZone } from './time.ts'

export type WebOptions = RegisterOptions & {
  project: string | null
  task: string | null
  visible: boolean
  rehearse: boolean
}

type WebSettings = { dateFormat: string; timeFormat: string; timeZone: string; myStartOfDay: string }

type WebEntry = {
  id: string
  description: string | null
  project: { name: string } | null
  task: { name: string } | null
  timeInterval: { zonedStart: string; zonedEnd: string | null }
}

type TrackerState = {
  settings: WebSettings | null
  entries: Map<string, WebEntry>
  total: number
  pages: number
}

const STEP_TIMEOUT_MS = 15_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function watchTracker(page: Page) {
  const state: TrackerState = { settings: null, entries: new Map(), total: 0, pages: 0 }
  page.on('response', async (response) => {
    const url = response.url()
    try {
      if (/\/api\/users\/[0-9a-f]{24}\/$/.test(url)) {
        state.settings = ((await response.json()) as { settings: WebSettings }).settings
      } else if (/\/timeEntries\/user\/[0-9a-f]{24}\/full\?/.test(url) && response.request().method() === 'GET') {
        const body = (await response.json()) as { timeEntriesList: WebEntry[]; allEntriesCount: number }
        for (const entry of body.timeEntriesList) state.entries.set(entry.id, entry)
        state.total = body.allEntriesCount
        state.pages++
      }
    } catch {}
  })
  return state
}

async function waitFor(condition: () => boolean, message: string, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message)
    await sleep(200)
  }
}

const entryProjectKey = (project: string | null, task: string | null) =>
  project ? normalize(`${project}|${task ?? ''}`) : null

function toExisting(entries: Iterable<WebEntry>) {
  const now = new Date()
  const nowLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return [...entries].flatMap((entry): ExistingEntry[] => {
    const startText = entry.timeInterval.zonedStart
    const endText = entry.timeInterval.zonedEnd ?? nowLocal
    const startDate = startText.slice(0, 10)
    const endDate = endText.slice(0, 10)
    const start = parseClock(startText.slice(11, 16)) ?? 0
    const end = parseClock(endText.slice(11, 16)) ?? 0
    const base = {
      description: entry.description ?? '',
      projectId: entryProjectKey(entry.project?.name ?? null, entry.task?.name ?? null),
    }
    if (startDate === endDate) return [{ ...base, date: startDate, start, end }]
    return [
      { ...base, date: startDate, start, end: DAY_MINUTES },
      { ...base, date: endDate, start: 0, end },
    ]
  })
}

function oldestLoadedDate(state: TrackerState) {
  let oldest: string | null = null
  for (const entry of state.entries.values()) {
    const date = entry.timeInterval.zonedStart.slice(0, 10)
    if (!oldest || date < oldest) oldest = date
  }
  return oldest
}

async function loadEntriesSince(page: Page, state: TrackerState, date: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const oldest = oldestLoadedDate(state)
    if (state.entries.size >= state.total || (oldest && oldest < date)) return
    const pages = state.pages
    const loadMore = page.getByRole('button', { name: /load more|cargar m[aá]s/i }).first()
    if (!(await loadMore.isVisible().catch(() => false))) {
      await page.mouse.wheel(0, 20_000)
      await sleep(800)
    }
    if (!(await loadMore.isVisible().catch(() => false))) {
      throw new Error(`No pude cargar tus entradas anteriores al ${formatDay(oldest ?? date)} para revisar duplicados.`)
    }
    await loadMore.click()
    await waitFor(() => state.pages > pages, 'Clockify no respondió al cargar más entradas.')
  }
}

function entryBar(page: Page) {
  return page
    .locator('main input.cl-input-timetracker-main')
    .first()
    .locator('xpath=ancestor::*[.//input[@aria-label="Start time"]][1]')
}

async function typeInto(page: Page, field: Locator, value: string) {
  await field.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(value, { delay: 15 })
  await page.keyboard.press('Tab')
}

function runningEntry(state: TrackerState) {
  return [...state.entries.values()].find((entry) => !entry.timeInterval.zonedEnd) ?? null
}

async function ensureManualMode(page: Page, state: TrackerState) {
  const running = runningEntry(state)
  const stopButton = await page.locator('main').getByRole('button', { name: /^stop$/i }).count()
  if (running || stopButton) {
    const detail = running
      ? ` («${running.description ?? 'sin descripción'}», desde las ${running.timeInterval.zonedStart.slice(11, 16)})`
      : ''
    throw new Error(
      `Tienes un timer corriendo en Clockify${detail}. Detenlo o descártalo tú y vuelve a correr el comando; no toqué nada.`,
    )
  }
  const isManual = async () => {
    const bar = entryBar(page)
    return (
      (await bar.locator('input[aria-label="Start time"]').count()) > 0 &&
      (await bar.getByRole('button', { name: 'Add', exact: true }).count()) > 0
    )
  }
  if (await isManual()) return
  await page.locator('main a[data-cy="manual-mode"]').first().click()
  for (let attempt = 0; attempt < 15 && !(await isManual()); attempt++) await sleep(200)
  if (!(await isManual())) {
    throw new Error('La barra de Clockify no está en modo manual. Cámbiala con el ícono de lista (a la derecha de la barra) y vuelve a correr el comando.')
  }
}

async function selectedProjectTask(page: Page) {
  return (await entryBar(page).locator('.cl-dropdown-large').first().innerText()).trim()
}

async function selectProjectTask(page: Page, project: string, task: string | null) {
  const bar = entryBar(page)
  const current = await selectedProjectTask(page)
  if (current.includes(project) && (!task || current.includes(`: ${task}`))) return
  await bar.locator('.cl-dropdown-large .cl-dropdown-toggle').first().click()
  const search = page.getByRole('textbox', { name: 'Search Project or Client' })
  await search.waitFor({ timeout: STEP_TIMEOUT_MS })
  await search.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await search.pressSequentially(project, { delay: 15 })
  await sleep(1200)

  const projectButton = page.locator(`button.cl-btn-project-picker[title=${JSON.stringify(project)}]`)
  const count = await projectButton.count()
  if (count !== 1) {
    await page.keyboard.press('Escape')
    throw new Error(
      count ? `Hay ${count} proyectos llamados «${project}» en Clockify.` : `No encontré el proyecto «${project}» en Clockify.`,
    )
  }

  if (!task) {
    await projectButton.click()
  } else {
    const row = projectButton.locator('xpath=ancestor::div[contains(@class,"cl-dropdown-item")][1]')
    const expander = row.locator('.cl-tasks-parent button').first()
    if (!(await expander.locator('img[alt="Up arrow symbol"]').count())) {
      await expander.click()
      await sleep(600)
    }
    const taskButton = page.getByRole('button', { name: task, exact: true })
    const tasks = await taskButton.count()
    if (tasks !== 1) {
      await page.keyboard.press('Escape')
      throw new Error(
        tasks
          ? `La tarea «${task}» aparece ${tasks} veces; no sé cuál elegir.`
          : `No encontré la tarea «${task}» dentro de «${project}».`,
      )
    }
    await taskButton.click()
  }
  await sleep(500)

  const chosen = await selectedProjectTask(page)
  if (!chosen.includes(project) || (task && !chosen.includes(task))) {
    throw new Error(`Elegí «${project}${task ? `: ${task}` : ''}», pero Clockify muestra «${chosen}».`)
  }
}

function formatDate(date: string, dateFormat: string) {
  const [year, month, day] = date.split('-')
  return dateFormat.replace('YYYY', year).replace('MM', month).replace('DD', day)
}

function formatTime(minutes: number, timeFormat: string) {
  if (timeFormat !== 'HOUR12') return formatClock(minutes)
  const hours = Math.floor(minutes / 60)
  const suffix = hours < 12 ? 'AM' : 'PM'
  return `${String(hours % 12 || 12).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${suffix}`
}

function parseShownDuration(value: string) {
  const parts = value.trim().split(':').map(Number)
  if (parts.length > 1) return parts[0] * 60 + parts[1] + (parts[2] ?? 0) / 60
  return Number(value.replace(',', '.')) * 60
}

async function fillEntry(page: Page, settings: WebSettings, item: PlanItem, block: Interval, today: string) {
  const bar = entryBar(page)
  const description = bar.locator('input.cl-input-timetracker-main').first()
  for (let attempt = 0; attempt < 3; attempt++) {
    await description.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await description.pressSequentially(item.description, { delay: 15 + attempt * 25 })
    await sleep(400)
    if ((await description.inputValue()) === item.description) break
  }
  await page.keyboard.press('Escape')

  if (item.projectName) await selectProjectTask(page, item.projectName, item.taskName ?? null)

  const start = bar.locator('input[aria-label="Start time"]').first()
  const end = bar.locator('input[aria-label="End time"]').first()
  const date = bar.locator('.cl-input-date-picker-container input').first()
  await typeInto(page, start, formatTime(block.start, settings.timeFormat))
  await typeInto(page, end, formatTime(block.end, settings.timeFormat))
  await date.click()
  await sleep(300)
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(formatDate(item.date, settings.dateFormat), { delay: 15 })
  await page.keyboard.press('Tab')
  await sleep(500)

  const shown = {
    description: await description.inputValue(),
    start: await start.inputValue(),
    end: await end.inputValue(),
    date: await date.inputValue(),
    duration: await bar.locator('input').last().inputValue(),
  }
  const expectedDates = [formatDate(item.date, settings.dateFormat)]
  if (item.date === today) expectedDates.push('Today', 'Hoy')
  if (item.date === addDays(today, -1)) expectedDates.push('Yesterday', 'Ayer')
  const problems = [
    shown.description !== item.description && `descripción «${shown.description}»`,
    parseClock(shown.start) !== block.start && `inicio ${shown.start}`,
    parseClock(shown.end) !== block.end && `fin ${shown.end}`,
    !expectedDates.includes(shown.date) && `fecha ${shown.date}`,
    Math.abs(parseShownDuration(shown.duration) - (block.end - block.start)) > 1 && `duración ${shown.duration}`,
  ].filter(Boolean)
  if (problems.length) {
    throw new Error(`El formulario de Clockify no quedó como esperaba (${problems.join(', ')}); no lo guardé.`)
  }
}

async function addEntry(page: Page) {
  const bar = entryBar(page)
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/timeEntries(\/|\?|$)/.test(new URL(response.url()).pathname),
    { timeout: STEP_TIMEOUT_MS },
  )
  await bar.getByRole('button', { name: 'Add', exact: true }).click()
  const response = await saved.catch(() => null)
  if (!response) throw new Error('Clockify no confirmó que guardó la entrada.')
  if (response.status() >= 300) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(`Clockify rechazó la entrada (${response.status()}${body?.message ? `: ${body.message}` : ''}).`)
  }
  const description = bar.locator('input.cl-input-timetracker-main').first()
  for (let attempt = 0; attempt < 25 && (await description.inputValue()) !== ''; attempt++) await sleep(200)
}

async function verifySaved(page: Page, state: TrackerState, pending: PlanItem[]) {
  const pages = state.pages
  await openTracker(page)
  await waitFor(() => state.pages > pages, 'No pude recargar tus entradas para comprobarlas.').catch(() => {})
  const saved = toExisting(state.entries.values())
  const missing = pending.flatMap((item) =>
    item.blocks.filter(
      (block) =>
        !saved.some(
          (entry) =>
            entry.date === item.date &&
            entry.start === block.start &&
            entry.end === block.end &&
            normalize(entry.description) === normalize(item.description),
        ),
    ).map((block) => `${formatDay(item.date)} ${formatClock(block.start)}–${formatClock(block.end)} ${item.description}`),
  )
  if (missing.length) {
    throw new Error(`Clockify no muestra ${missing.length} entrada(s) que debí crear:\n  ${missing.join('\n  ')}`)
  }
  console.log('Comprobé en Clockify que todas quedaron guardadas.')
}

function buildTargets(rows: EntryRow[], options: WebOptions) {
  const errors: string[] = []
  const targets: Target[] = []
  for (const row of rows) {
    if (row.tags.length || row.billable !== null) {
      errors.push(`${row.label}: en modo navegador todavía no manejo «etiquetas» ni «facturable»; quítalas de esa fila.`)
      continue
    }
    const project = row.project ?? options.project
    const task = row.project ? row.task : (row.task ?? options.task)
    if (!project) {
      errors.push(`${row.label}: falta el proyecto. Ponlo en la fila o guárdalo con «npm run preferencias -- --proyecto ...».`)
      continue
    }
    const description = row.note ? `${row.ticket} — ${row.note}` : row.ticket
    for (const date of row.dates) {
      targets.push({
        row,
        date,
        description,
        projectId: entryProjectKey(project, task),
        projectName: project,
        taskName: task,
        taskId: null,
        tagIds: [],
        billable: null,
      })
    }
  }
  return { targets, errors }
}

export async function registerInBrowser(file: string, options: WebOptions) {
  const firstPass = await readEntries(file, options.today ?? localParts(Date.now(), systemTimeZone()).date)
  if (firstPass.errors.length) throw new Error(`Revisa el archivo:\n  ${firstPass.errors.join('\n  ')}`)

  const { context, page } = await openBrowser({ headless: !options.visible })
  try {
    const state = watchTracker(page)
    if (!(await openTracker(page))) {
      throw new Error('La sesión del navegador ya no es válida. Corre «npm run login-navegador».')
    }
    await waitFor(() => Boolean(state.settings) && state.pages > 0, 'Clockify no terminó de cargar tu Time Tracker.')
    const settings = state.settings!
    const timeZone = options.timeZone ?? settings.timeZone
    const today = options.today ?? localParts(Date.now(), timeZone).date

    const { rows, errors } = await readEntries(file, today)
    if (errors.length) throw new Error(`Revisa el archivo:\n  ${errors.join('\n  ')}`)
    const { targets, errors: targetErrors } = buildTargets(rows, options)
    if (targetErrors.length) throw new Error(`Revisa el archivo:\n  ${targetErrors.join('\n  ')}`)

    if (!options.dryRun) {
      await ensureManualMode(page, state)
      const pairs = new Map(targets.map((target) => [target.projectId, target]))
      for (const target of pairs.values()) {
        await selectProjectTask(page, target.projectName!, target.taskName ?? null)
      }
      await openTracker(page)
    }

    const dates = [...new Set(targets.map((target) => target.date))].sort()
    await loadEntriesSince(page, state, dates[0])
    const existing = toExisting(state.entries.values())
    const plan = buildPlan(targets, existing, {
      dayStart: options.dayStart ?? parseClock(settings.myStartOfDay) ?? 9 * 60,
      lunch: options.lunch,
      allowOverlap: options.allowOverlap,
    })

    console.log(`Modo navegador · zona horaria de tu perfil: ${timeZone}`)
    const running = runningEntry(state)
    if (running) {
      console.log(
        `Ojo: tienes un timer corriendo («${running.description ?? 'sin descripción'}», desde las ${running.timeInterval.zonedStart.slice(11, 16)}). Hay que detenerlo antes de registrar.`,
      )
    }
    const review = await reviewPlan(plan, existing, options.rehearse ? { ...options, yes: true } : options)
    if (!review) return { created: 0 }

    if (options.rehearse) {
      const [item] = review.pending
      await ensureManualMode(page, state)
      await fillEntry(page, settings, item, item.blocks[0], today)
      await page.screenshot({ path: 'ensayo-clockify.png' })
      console.log('\nEnsayo: llené el formulario con la primera entrada y NO la guardé. Mira ensayo-clockify.png.')
      return { created: 0 }
    }

    let created = 0
    for (const item of review.pending) {
      for (const block of item.blocks) {
        try {
          await ensureManualMode(page, state)
          await fillEntry(page, settings, item, block, today)
          await addEntry(page)
          created++
          console.log(`  ✓ ${formatDay(item.date)} ${formatClock(block.start)}–${formatClock(block.end)}  ${item.description}`)
        } catch (error) {
          console.log(`\nSe registraron ${created} de ${review.entryCount} entradas antes del error.`)
          await page.screenshot({ path: 'error-clockify.png' }).catch(() => {})
          throw new Error(
            `${item.row.label} (${formatDay(item.date)}): ${(error as Error).message}\nGuardé una captura en error-clockify.png. Lo que ya se registró no se repite si corres el comando otra vez.`,
          )
        }
      }
    }
    console.log(`\nListo: se registraron ${created} de ${review.entryCount} entradas.`)
    await verifySaved(page, state, review.pending)
    return { created }
  } finally {
    await closeQuietly(context)
  }
}

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'

export const CLOCKIFY_APP = 'https://app.clockify.me'
const CHROME_START_TIMEOUT_MS = 30_000
const LOGIN_STABLE_MS = 5000
const APP_PAGES = /^https:\/\/app\.clockify\.me\/(?:[a-z]{2}\/)?(tracker|timesheet|calendar|dashboard|reports|projects)/
const CHROME_PATH =
  process.env.CLOCKIFY_HORAS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function profilePath() {
  return process.env.CLOCKIFY_HORAS_NAVEGADOR || join(homedir(), '.config', 'clockify-horas', 'navegador')
}

export async function openBrowser(options: { headless: boolean }) {
  const context = await chromium.launchPersistentContext(profilePath(), {
    channel: 'chrome',
    headless: options.headless,
    viewport: { width: 1440, height: 900 },
    locale: 'es-ES',
  })
  const page = context.pages()[0] ?? (await context.newPage())
  return { context, page }
}

export function isLoggedIn(page: Page) {
  return APP_PAGES.test(page.url())
}

export async function openTracker(page: Page) {
  await page.goto(`${CLOCKIFY_APP}/tracker`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  return isLoggedIn(page)
}

export async function closeQuietly(context: BrowserContext) {
  await context.close().catch(() => {})
}

export async function hasBrowserSession() {
  const { context, page } = await openBrowser({ headless: true })
  try {
    return await openTracker(page)
  } finally {
    await closeQuietly(context)
  }
}

async function debuggingPort() {
  const content = await readFile(join(profilePath(), 'DevToolsActivePort'), 'utf8').catch(() => '')
  return Number(content.split('\n')[0]) || null
}

async function openTabUrls(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  const tabs = (await response.json()) as { type: string; url: string }[]
  return tabs.filter((tab) => tab.type === 'page').map((tab) => tab.url)
}

async function closeChrome(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`)
  const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl: string }
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    socket.onclose = () => resolve()
    socket.onerror = () => resolve()
  })
}

async function runningPort() {
  const port = await debuggingPort()
  if (!port) return null
  return openTabUrls(port)
    .then(() => port)
    .catch(() => null)
}

async function waitUntilClosed(port: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const alive = await openTabUrls(port)
      .then(() => true)
      .catch(() => false)
    if (!alive) break
    await sleep(500)
  }
  await sleep(1000)
}

export async function loginInBrowser() {
  await mkdir(profilePath(), { recursive: true, mode: 0o700 })
  let port = await runningPort()
  if (port) {
    console.log('Ya hay una ventana de Chrome abierta con este perfil; termina de iniciar sesión ahí.')
  } else {
    await rm(join(profilePath(), 'DevToolsActivePort'), { force: true })
    spawn(
      CHROME_PATH,
      [
        `--user-data-dir=${profilePath()}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `${CLOCKIFY_APP}/login`,
      ],
      { stdio: 'ignore', detached: true },
    ).unref()
    console.log('Inicia sesión en Clockify en la ventana de Chrome que se abrió (correo o Google, como siempre).')
  }
  console.log('Si Google te pide verificar en el teléfono, tómate el tiempo que necesites: la ventana espera.')
  console.log('Cuando llegues a tu Time Tracker, espera unos segundos: la sesión queda guardada y la ventana se cierra sola.')

  const startedAt = Date.now()
  let seenBrowser = Boolean(port)
  let insideSince: number | null = null
  for (;;) {
    await sleep(1000)
    port = await runningPort()
    if (!port) {
      if (seenBrowser) throw new Error('Cerraste Chrome antes de terminar de iniciar sesión. Corre el comando otra vez.')
      if (Date.now() - startedAt > CHROME_START_TIMEOUT_MS) throw new Error(`No pude abrir Chrome (${CHROME_PATH}).`)
      continue
    }
    seenBrowser = true
    const urls = await openTabUrls(port).catch(() => [])
    if (!urls.some((url) => APP_PAGES.test(url))) {
      insideSince = null
      continue
    }
    insideSince ??= Date.now()
    if (Date.now() - insideSince >= LOGIN_STABLE_MS) {
      await closeChrome(port).catch(() => {})
      await waitUntilClosed(port)
      break
    }
  }

  if (!(await hasBrowserSession())) {
    throw new Error('Chrome se cerró, pero Clockify no quedó con la sesión iniciada. Corre el comando otra vez.')
  }
  console.log(`Sesión guardada en ${profilePath()}`)
}

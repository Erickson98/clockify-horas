import { ClockifyError, createClient, GLOBAL_API, REGIONAL_APIS } from './clockify.ts'
import { askSecret, choose, openInBrowser } from './prompt.ts'
import { saveSession, sessionPath } from './session.ts'
import { isValidTimeZone, systemTimeZone } from './time.ts'

const API_KEYS_URL = 'https://app.clockify.me/user/preferences#advanced'

async function connect(apiKey: string, forcedUrl: string | undefined) {
  let lastError: unknown
  for (const baseUrl of forcedUrl ? [forcedUrl] : [GLOBAL_API, ...REGIONAL_APIS]) {
    const client = createClient(apiKey, baseUrl)
    try {
      return { client, baseUrl, user: await client.getUser() }
    } catch (error) {
      if (!(error instanceof ClockifyError) || ![401, 403].includes(error.status)) throw error
      lastError = error
    }
  }
  throw lastError
}

async function readApiKey(openBrowser: boolean) {
  const fromEnv = process.env.CLOCKIFY_API_KEY?.trim()
  if (fromEnv) return fromEnv
  console.log('Para conectarte necesitas una API key personal de Clockify.')
  console.log('En Clockify: Perfil → Preferencias → Avanzado → Manage API keys → Generate new.')
  if (openBrowser && (await openInBrowser(API_KEYS_URL))) {
    console.log('Te abrí esa página en el navegador; si te pide iniciar sesión, entra con tu cuenta.')
  } else {
    console.log(`Ábrela aquí: ${API_KEYS_URL}`)
  }
  return askSecret('\nPega tu API key: ')
}

export async function login(options: { openBrowser: boolean; baseUrl?: string }) {
  const apiKey = await readApiKey(options.openBrowser)
  if (!apiKey) throw new Error('No recibí ninguna API key.')

  const { client, baseUrl, user } = await connect(apiKey, options.baseUrl)
  console.log(`\nConectado como ${user.name || user.email}.`)

  const workspaces = await client.getWorkspaces()
  if (!workspaces.length) throw new Error('Tu usuario no pertenece a ningún workspace de Clockify.')
  const active = Math.max(
    0,
    workspaces.findIndex((workspace) => workspace.id === user.activeWorkspace),
  )
  const workspaceIndex =
    workspaces.length === 1
      ? 0
      : ((await choose(
          '¿En qué workspace registras tus horas?',
          workspaces.map((workspace) => workspace.name),
          active,
        )) ?? active)
  const workspace = workspaces[workspaceIndex]

  const projects = await client.listProjects(workspace.id)
  const projectIndex = projects.length
    ? await choose(
        'Proyecto por defecto para las filas que no indiquen uno:',
        projects.map((project) => project.name),
        null,
      )
    : null
  const defaultProject = projectIndex === null ? null : projects[projectIndex]

  const timeZone = user.settings?.timeZone
  const dayStart = user.settings?.myStartOfDay
  await saveSession({
    apiKey,
    baseUrl,
    user: { id: user.id, name: user.name || user.email, email: user.email },
    workspace: { id: workspace.id, name: workspace.name },
    defaultProject: defaultProject && { id: defaultProject.id, name: defaultProject.name },
    timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : systemTimeZone(),
    dayStart: dayStart && /^\d{2}:\d{2}$/.test(dayStart) ? dayStart : '09:00',
    savedAt: new Date().toISOString(),
  })

  console.log(`\nSesión guardada en ${sessionPath()}`)
  console.log(`Workspace: ${workspace.name}`)
  console.log(`Proyecto por defecto: ${defaultProject?.name ?? 'ninguno'}`)
  console.log('\nYa puedes registrar horas:  npm run registrar -- horas.csv')
}

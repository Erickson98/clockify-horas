import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Session = {
  apiKey: string
  baseUrl: string
  user: { id: string; name: string; email: string }
  workspace: { id: string; name: string }
  defaultProject: { id: string; name: string } | null
  timeZone: string
  dayStart: string
  savedAt: string
}

export function sessionPath() {
  return process.env.CLOCKIFY_HORAS_SESION || join(homedir(), '.config', 'clockify-horas', 'sesion.json')
}

export async function loadSession(): Promise<Session | null> {
  try {
    return JSON.parse(await readFile(sessionPath(), 'utf8')) as Session
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`No pude leer la sesión guardada en ${sessionPath()}: ${(error as Error).message}`)
  }
}

export async function requireSession() {
  const session = await loadSession()
  if (!session) throw new Error('No hay sesión guardada. Corre primero «npm run login».')
  return session
}

export async function saveSession(session: Session) {
  const path = sessionPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function clearSession() {
  await rm(sessionPath(), { force: true })
}

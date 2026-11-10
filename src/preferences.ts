import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Preferences = {
  proyecto?: string
  tarea?: string
  inicioJornada?: string
  almuerzo?: string | null
}

export function preferencesPath() {
  return process.env.CLOCKIFY_HORAS_PREFERENCIAS || join(homedir(), '.config', 'clockify-horas', 'preferencias.json')
}

export async function loadPreferences(): Promise<Preferences> {
  try {
    return JSON.parse(await readFile(preferencesPath(), 'utf8')) as Preferences
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`No pude leer ${preferencesPath()}: ${(error as Error).message}`)
  }
}

export async function savePreferences(preferences: Preferences) {
  const path = preferencesPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`)
}

export function describePreferences(preferences: Preferences) {
  return [
    `Proyecto por defecto: ${preferences.proyecto ?? '(sin definir)'}`,
    `Tarea por defecto: ${preferences.tarea ?? '(sin definir)'}`,
    `Inicio de jornada: ${preferences.inicioJornada ?? '(el de tu perfil de Clockify)'}`,
    `Almuerzo: ${preferences.almuerzo === null ? 'sin almuerzo' : (preferences.almuerzo ?? '12:00-13:00')}`,
  ].join('\n')
}

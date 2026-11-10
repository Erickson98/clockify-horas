import { access } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { loginInBrowser, profilePath } from './browser.ts'
import { parseClock } from './input.ts'
import { login } from './login.ts'
import type { Interval } from './plan.ts'
import { describePreferences, loadPreferences, preferencesPath, savePreferences } from './preferences.ts'
import { listProjects } from './projects.ts'
import { register } from './register.ts'
import { clearSession, loadSession, sessionPath } from './session.ts'
import { isValidTimeZone } from './time.ts'
import { registerInBrowser } from './web.ts'

const HELP = `Uso:
  npm run login-navegador               Abre Chrome para iniciar sesión en Clockify (una vez)
  npm run preferencias -- [opciones]    Guarda proyecto, tarea, inicio de jornada y almuerzo por defecto
  npm run registrar -- <archivo>        Registra las horas de un .csv o .json
  npm run login                         Conecta con una API key en vez del navegador
  npm run proyectos                     Lista los proyectos (solo con API key)
  npm run logout                        Borra la sesión de API key

Opciones de registrar:
  --prueba                Muestra el horario sin tocar nada
  --ensayo                Llena el formulario de la primera entrada sin guardarla (modo navegador)
  --ver                   Muestra la ventana de Chrome mientras trabaja (modo navegador)
  --si                    No pide confirmación
  --proyecto "Nombre"     Proyecto para las filas que no lo indiquen
  --tarea "Nombre"        Tarea para las filas que no la indiquen
  --inicio-jornada 08:00  Hora desde la que se acomodan las filas sin inicio
  --almuerzo 12:00-13:00  Hueco que se salta al acomodar
  --sin-almuerzo          No reserva hueco de almuerzo
  --permitir-solapes      Crea entradas aunque choquen con otras
  --zona America/Santo_Domingo   Zona horaria (por defecto la de tu perfil de Clockify)
  --api / --navegador     Fuerza el modo (por defecto: API si hiciste «npm run login», si no navegador)

Ejemplos:
  npm run preferencias -- --proyecto "Automatización de Procesos" --tarea "Client Work" --inicio-jornada 08:00
  npm run registrar -- horas.csv --prueba`

function parseLunch(value: string): Interval {
  const [start, end] = value.split(/\s*[-–]\s*/).map(parseClock)
  if (start == null || end == null || end <= start) {
    throw new Error(`El almuerzo «${value}» no es válido. Usa por ejemplo 12:00-13:00.`)
  }
  return { start, end }
}

function parseDayStart(value: string) {
  const minutes = parseClock(value)
  if (minutes === null) throw new Error(`El inicio de jornada «${value}» no es válido. Usa por ejemplo 08:00.`)
  return minutes
}

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false)

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      prueba: { type: 'boolean', default: false },
      ensayo: { type: 'boolean', default: false },
      ver: { type: 'boolean', default: false },
      si: { type: 'boolean', default: false },
      api: { type: 'boolean', default: false },
      navegador: { type: 'boolean', default: false },
      proyecto: { type: 'string' },
      tarea: { type: 'string' },
      'permitir-solapes': { type: 'boolean', default: false },
      'inicio-jornada': { type: 'string' },
      almuerzo: { type: 'string' },
      'sin-almuerzo': { type: 'boolean', default: false },
      zona: { type: 'string' },
      'sin-navegador': { type: 'boolean', default: false },
      url: { type: 'string' },
      ayuda: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, ...args] = positionals

  if (values.ayuda || !command || command === 'ayuda') {
    console.log(HELP)
    return
  }

  switch (command) {
    case 'login':
      await login({ openBrowser: !values['sin-navegador'], baseUrl: values.url?.replace(/\/+$/, '') })
      return
    case 'login-navegador':
      await loginInBrowser()
      return
    case 'logout': {
      const hadSession = Boolean(await loadSession())
      await clearSession()
      console.log(hadSession ? `Sesión borrada (${sessionPath()}).` : 'No había sesión guardada.')
      return
    }
    case 'proyectos':
      await listProjects()
      return
    case 'preferencias': {
      const preferences = await loadPreferences()
      const changed = Boolean(
        values.proyecto || values.tarea || values['inicio-jornada'] || values.almuerzo || values['sin-almuerzo'],
      )
      if (values.proyecto) preferences.proyecto = values.proyecto.trim()
      if (values.tarea) preferences.tarea = values.tarea.trim()
      if (values['inicio-jornada']) {
        preferences.inicioJornada = values['inicio-jornada']
        parseDayStart(preferences.inicioJornada)
      }
      if (values.almuerzo) {
        parseLunch(values.almuerzo)
        preferences.almuerzo = values.almuerzo
      }
      if (values['sin-almuerzo']) preferences.almuerzo = null
      if (changed) await savePreferences(preferences)
      console.log(`${changed ? 'Guardé' : 'Tus'} preferencias (${preferencesPath()}):\n\n${describePreferences(preferences)}`)
      return
    }
    case 'registrar': {
      if (!args[0]) throw new Error('Indica el archivo: npm run registrar -- horas.csv')
      if (values.zona && !isValidTimeZone(values.zona)) {
        throw new Error(`--zona «${values.zona}» no es una zona horaria válida.`)
      }
      const preferences = await loadPreferences()
      const dayStartText = values['inicio-jornada'] ?? preferences.inicioJornada
      const lunchText = values['sin-almuerzo'] ? null : (values.almuerzo ?? preferences.almuerzo)
      const options = {
        dryRun: values.prueba,
        yes: values.si,
        allowOverlap: values['permitir-solapes'],
        lunch: lunchText === null ? null : parseLunch(lunchText ?? '12:00-13:00'),
        dayStart: dayStartText ? parseDayStart(dayStartText) : null,
        timeZone: values.zona ?? null,
      }

      const useApi = values.api || (!values.navegador && Boolean(await loadSession()))
      if (useApi) {
        await register(args[0], options)
        return
      }
      if (!(await exists(profilePath()))) {
        throw new Error('Primero inicia sesión: «npm run login-navegador» (o «npm run login» para usar una API key).')
      }
      await registerInBrowser(args[0], {
        ...options,
        project: values.proyecto ?? preferences.proyecto ?? null,
        task: values.tarea ?? preferences.tarea ?? null,
        visible: values.ver,
        rehearse: values.ensayo,
      })
      return
    }
    default:
      throw new Error(`No conozco el comando «${command}».\n\n${HELP}`)
  }
}

main().catch((error: Error & { code?: string }) => {
  const option = error.message.match(/'(-[^']+)'/)?.[1]
  const message =
    error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
      ? `No conozco la opción ${option ?? ''}. Mira las opciones con «npm run ayuda».`
      : error.message
  console.error(`\n✖ ${message}`)
  process.exitCode = 1
})

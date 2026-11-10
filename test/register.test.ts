import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import type { Session } from '../src/session.ts'

type Call = { method: string; path: string; query: URLSearchParams; body: unknown; apiKey: string | undefined }

const calls: Call[] = []
let existingEntries: unknown[] = []
let failPostsAfter = Infinity
let baseUrl = ''
let dir = ''

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  let raw = ''
  for await (const chunk of request) raw += chunk
  calls.push({
    method: request.method ?? '',
    path: url.pathname,
    query: url.searchParams,
    body: raw ? JSON.parse(raw) : null,
    apiKey: request.headers['x-api-key'] as string | undefined,
  })
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Last-Page': 'true' })
    response.end(JSON.stringify(body))
  }
  const path = url.pathname
  if (path === '/api/v1/workspaces/ws1/projects') {
    return send(200, [
      { id: 'p1', name: 'CONEP CRM', archived: false },
      { id: 'p2', name: 'CONEP Backend', archived: false },
    ])
  }
  if (path === '/api/v1/workspaces/ws1/tags') return send(200, [{ id: 't1', name: 'frontend', archived: false }])
  if (path === '/api/v1/workspaces/ws1/user/u1/time-entries') return send(200, existingEntries)
  if (path === '/api/v1/workspaces/ws1/time-entries' && request.method === 'POST') {
    const created = calls.filter((call) => call.method === 'POST').length
    if (created > failPostsAfter) return send(429, { message: 'Too many requests', code: 429 })
    return send(201, { id: `e${created}` })
  }
  send(404, { message: 'not found' })
})

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  dir = await mkdtemp(join(tmpdir(), 'clockify-horas-'))
  process.env.CLOCKIFY_HORAS_SESION = join(dir, 'sesion.json')
  const session: Session = {
    apiKey: 'clave-de-prueba',
    baseUrl,
    user: { id: 'u1', name: 'Eri', email: 'eri@example.com' },
    workspace: { id: 'ws1', name: 'Intellisys' },
    defaultProject: { id: 'p1', name: 'CONEP CRM' },
    timeZone: 'America/Santo_Domingo',
    dayStart: '09:00',
    savedAt: '2026-11-10T00:00:00.000Z',
  }
  await writeFile(process.env.CLOCKIFY_HORAS_SESION, JSON.stringify(session))
})

after(() => server.close())

beforeEach(() => {
  calls.length = 0
  existingEntries = []
  failPostsAfter = Infinity
  mock.method(console, 'log', () => {})
})

afterEach(() => mock.restoreAll())

const OPTIONS = {
  dryRun: false,
  yes: true,
  allowOverlap: false,
  lunch: { start: 12 * 60, end: 13 * 60 },
  dayStart: null,
  timeZone: null,
  today: '2026-11-10',
}

async function csv(content: string) {
  const path = join(dir, `horas-${Math.random().toString(36).slice(2)}.csv`)
  await writeFile(path, content)
  return path
}

const posts = () => calls.filter((call) => call.method === 'POST').map((call) => call.body)

test('crea las entradas en UTC con proyecto, etiquetas y la API key', async () => {
  const { register } = await import('../src/register.ts')
  const file = await csv(
    'fecha,ticket,horas,inicio,proyecto,descripcion,etiquetas,facturable\n' +
      '2026-11-10,Daily,0:15,09:00,,,,\n' +
      '2026-11-10,CONEP-101 Alertas,3,,backend,Filtros,frontend,no\n',
  )
  const result = await register(file, OPTIONS)

  assert.equal(result.created, 3)
  assert.deepEqual(posts(), [
    { start: '2026-11-10T13:00:00Z', end: '2026-11-10T13:15:00Z', description: 'Daily', projectId: 'p1' },
    {
      start: '2026-11-10T13:15:00Z',
      end: '2026-11-10T16:00:00Z',
      description: 'CONEP-101 Alertas — Filtros',
      projectId: 'p2',
      tagIds: ['t1'],
      billable: false,
    },
    {
      start: '2026-11-10T17:00:00Z',
      end: '2026-11-10T17:15:00Z',
      description: 'CONEP-101 Alertas — Filtros',
      projectId: 'p2',
      tagIds: ['t1'],
      billable: false,
    },
  ])
  assert.ok(calls.every((call) => call.apiKey === 'clave-de-prueba'))
  const listing = calls.find((call) => call.path.endsWith('/user/u1/time-entries'))
  assert.equal(listing?.query.get('start'), '2026-11-10T04:00:00Z')
  assert.equal(listing?.query.get('end'), '2026-11-11T04:00:00Z')
})

test('no repite lo que ya está registrado', async () => {
  const { register } = await import('../src/register.ts')
  existingEntries = [
    {
      id: 'x1',
      description: 'Daily',
      projectId: 'p1',
      timeInterval: { start: '2026-11-10T13:00:00Z', end: '2026-11-10T13:15:00Z' },
    },
  ]
  const file = await csv('fecha,ticket,horas,inicio\n2026-11-10,Daily,0:15,09:00\n2026-11-10,CONEP-5,1,\n')
  const result = await register(file, OPTIONS)
  assert.equal(result.created, 1)
  assert.deepEqual(posts(), [
    { start: '2026-11-10T13:15:00Z', end: '2026-11-10T14:15:00Z', description: 'CONEP-5', projectId: 'p1' },
  ])
})

test('en modo prueba no envía nada', async () => {
  const { register } = await import('../src/register.ts')
  const file = await csv('fecha,ticket,horas\n2026-11-10..2026-11-12,CONEP-7,2\n')
  const result = await register(file, { ...OPTIONS, dryRun: true })
  assert.equal(result.created, 0)
  assert.deepEqual(posts(), [])
})

test('se detiene sin enviar si una fila choca', async () => {
  const { register } = await import('../src/register.ts')
  existingEntries = [
    { id: 'x1', description: 'Otra', projectId: null, timeInterval: { start: '2026-11-10T13:00:00Z', end: '2026-11-10T15:00:00Z' } },
  ]
  const file = await csv('fecha,ticket,horas,inicio\n2026-11-10,CONEP-8,1,10:00\n2026-11-10,CONEP-9,1,\n')
  await assert.rejects(register(file, OPTIONS), /no puedo acomodar; no envié nada/)
  assert.deepEqual(posts(), [])
})

test('avisa los proyectos que no existen antes de consultar entradas', async () => {
  const { register } = await import('../src/register.ts')
  const file = await csv('fecha,ticket,horas,proyecto\n2026-11-10,CONEP-1,1,Inexistente\n2026-11-10,CONEP-2,1,conep\n')
  await assert.rejects(register(file, OPTIONS), (error: Error) => {
    assert.match(error.message, /línea 2: no encontré el proyecto «Inexistente»/)
    assert.match(error.message, /línea 3: «conep» coincide con varios/)
    return true
  })
  assert.ok(!calls.some((call) => call.path.endsWith('/time-entries')))
})

test('si Clockify limita las llamadas, corta y explica cómo seguir', async () => {
  const { register } = await import('../src/register.ts')
  failPostsAfter = 1
  const file = await csv('fecha,ticket,horas\n2026-11-10..2026-11-12,CONEP-7,2\n')
  await assert.rejects(register(file, OPTIONS), /30 por hora/)
  assert.equal(posts().length, 2)
})

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseClock, parseCsv, parseDates, parseDuration, readEntries } from '../src/input.ts'

async function tempFile(name: string, content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'clockify-horas-'))
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

test('parseCsv detecta el separador y respeta comillas', () => {
  assert.deepEqual(
    parseCsv('a;b;c\r\n1;"x; y";"dice ""hola"""\n').map((row) => row.cells),
    [
      ['a', 'b', 'c'],
      ['1', 'x; y', 'dice "hola"'],
    ],
  )
  assert.deepEqual(parseCsv('﻿a,b\n1,2').map((row) => row.cells), [
    ['a', 'b'],
    ['1', '2'],
  ])
})

test('parseCsv guarda la línea donde empieza cada fila', () => {
  const rows = parseCsv('a,b\n"x\ny",1\n\nz,2\n')
  assert.deepEqual(
    rows.map((row) => row.line),
    [1, 2, 4, 5],
  )
})

test('parseDuration acepta decimales, h:mm y minutos', () => {
  assert.equal(parseDuration('2'), 120)
  assert.equal(parseDuration('1.5'), 90)
  assert.equal(parseDuration('1,25'), 75)
  assert.equal(parseDuration('1:30'), 90)
  assert.equal(parseDuration('2h30'), 150)
  assert.equal(parseDuration('2h 30m'), 150)
  assert.equal(parseDuration('45m'), 45)
  assert.equal(parseDuration('3h'), 180)
  assert.equal(parseDuration('1:75'), null)
  assert.equal(parseDuration('abc'), null)
})

test('parseClock acepta 24 h y am/pm', () => {
  assert.equal(parseClock('09:00'), 540)
  assert.equal(parseClock('9'), 540)
  assert.equal(parseClock('14:30'), 870)
  assert.equal(parseClock('2:30 pm'), 870)
  assert.equal(parseClock('12:15 a. m.'), 15)
  assert.equal(parseClock('12 pm'), 720)
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('13 pm'), null)
})

test('parseDates entiende formatos, hoy/ayer y rangos de lunes a viernes', () => {
  const today = '2026-11-10'
  assert.deepEqual(parseDates('2026-11-10', today), ['2026-11-10'])
  assert.deepEqual(parseDates('10/11/2026', today), ['2026-11-10'])
  assert.deepEqual(parseDates('hoy', today), ['2026-11-10'])
  assert.deepEqual(parseDates('Ayer', today), ['2026-11-09'])
  assert.deepEqual(parseDates('2026-11-13..2026-11-17', today), ['2026-11-13', '2026-11-16', '2026-11-17'])
  assert.deepEqual(parseDates('13/11/2026 al 16/11/2026', today), ['2026-11-13', '2026-11-16'])
  assert.equal(parseDates('2026-11-14..2026-11-15', today), null)
  assert.equal(parseDates('2026-02-30', today), null)
  assert.equal(parseDates('2026-11-17..2026-11-10', today), null)
})

test('readEntries arma las filas con columnas en español y alias', async () => {
  const path = await tempFile(
    'horas.csv',
    'Fecha;Ticket;Horas;Hora de inicio;Proyecto;Descripción;Etiquetas;Facturable\n' +
      '2026-11-10;CONEP-1 Login;2,5;;CRM;Formulario;front|bug;sí\n' +
      '# comentario\n' +
      'hoy;CONEP-2;1:00;14:00;;;;\n',
  )
  const { rows, errors } = await readEntries(path, '2026-11-11')
  assert.deepEqual(errors, [])
  assert.equal(rows.length, 2)
  assert.deepEqual(
    { ...rows[0] },
    {
      label: 'línea 2',
      dates: ['2026-11-10'],
      ticket: 'CONEP-1 Login',
      minutes: 150,
      start: null,
      project: 'CRM',
      note: 'Formulario',
      task: null,
      tags: ['front', 'bug'],
      billable: true,
    },
  )
  assert.deepEqual(rows[1].dates, ['2026-11-11'])
  assert.equal(rows[1].start, 840)
})

test('readEntries junta todos los errores con su línea', async () => {
  const path = await tempFile(
    'horas.csv',
    'fecha,ticket,horas,inicio\n2026-13-01,CONEP-1,abc,25:00\n,,2,\n',
  )
  const { rows, errors } = await readEntries(path, '2026-11-10')
  assert.equal(rows.length, 0)
  assert.equal(errors.length, 5)
  assert.match(errors[0], /^línea 2: la fecha «2026-13-01»/)
  assert.match(errors[1], /^línea 2: las horas «abc»/)
  assert.match(errors[2], /^línea 2: la hora de inicio «25:00»/)
  assert.match(errors[3], /^línea 3: falta el «ticket»/)
  assert.match(errors[4], /^línea 3: falta la «fecha»/)
})

test('readEntries rechaza columnas desconocidas', async () => {
  const path = await tempFile('horas.csv', 'fecha,ticket,horas,proyeto\n2026-11-10,A,1,CRM\n')
  const { errors } = await readEntries(path, '2026-11-10')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /no conozco la columna «proyeto»/)
})

test('readEntries lee JSON con las mismas columnas', async () => {
  const path = await tempFile(
    'horas.json',
    JSON.stringify([{ fecha: '2026-11-10', ticket: 'CONEP-1', horas: 1.5, etiquetas: ['a', 'b'] }]),
  )
  const { rows, errors } = await readEntries(path, '2026-11-10')
  assert.deepEqual(errors, [])
  assert.equal(rows[0].minutes, 90)
  assert.deepEqual(rows[0].tags, ['a', 'b'])
  assert.equal(rows[0].label, 'elemento 1')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EntryRow } from '../src/input.ts'
import { buildPlan, type ExistingEntry, type PlanOptions, type Target } from '../src/plan.ts'

const OPTIONS: PlanOptions = { dayStart: 9 * 60, lunch: { start: 12 * 60, end: 13 * 60 }, allowOverlap: false }

function target(ticket: string, minutes: number, start: number | null = null, date = '2026-11-10'): Target {
  const row: EntryRow = {
    label: ticket,
    dates: [date],
    ticket,
    minutes,
    start,
    project: null,
    note: null,
    task: null,
    tags: [],
    billable: null,
  }
  return { row, date, description: ticket, projectId: 'p1', projectName: 'CRM', taskId: null, tagIds: [], billable: null }
}

function existing(description: string, start: number, end: number, date = '2026-11-10'): ExistingEntry {
  return { date, description, projectId: 'p1', start, end }
}

const blocks = (item: { blocks: { start: number; end: number }[] }) =>
  item.blocks.map(({ start, end }) => [start / 60, end / 60])

test('acomoda las filas sin inicio en orden y parte la que cruza el almuerzo', () => {
  const plan = buildPlan([target('A', 120), target('B', 120), target('C', 60)], [], OPTIONS)
  assert.deepEqual(plan.map(blocks), [
    [[9, 11]],
    [
      [11, 12],
      [13, 14],
    ],
    [[14, 15]],
  ])
  assert.ok(plan.every((item) => item.status === 'nueva'))
})

test('las filas con inicio van a su hora y las demás llenan los huecos', () => {
  const plan = buildPlan([target('Daily', 15, 9 * 60), target('A', 180), target('Tarde', 60, 14 * 60)], [], OPTIONS)
  assert.deepEqual(plan.map(blocks), [
    [[9, 9.25]],
    [
      [9.25, 12],
      [13, 13.25],
    ],
    [[14, 15]],
  ])
})

test('salta lo que ya está en Clockify y no lo duplica', () => {
  const plan = buildPlan(
    [target('A', 120), target('B', 60)],
    [existing('a', 9 * 60, 10 * 60), existing('A', 13 * 60, 14 * 60)],
    OPTIONS,
  )
  assert.equal(plan[0].status, 'existe')
  assert.equal(plan[0].alreadyLogged, 120)
  assert.deepEqual(blocks(plan[1]), [[10, 11]])
})

test('si solo una parte ya existe, registra lo que falta', () => {
  const plan = buildPlan([target('A', 180)], [existing('A', 9 * 60, 10 * 60)], OPTIONS)
  assert.equal(plan[0].status, 'nueva')
  assert.equal(plan[0].alreadyLogged, 60)
  assert.equal(plan[0].minutes, 120)
  assert.deepEqual(blocks(plan[0]), [[10, 12]])
})

test('marca los choques de las filas con inicio', () => {
  const plan = buildPlan([target('A', 60, 9 * 60 + 30)], [existing('Otra', 9 * 60, 10 * 60)], OPTIONS)
  assert.equal(plan[0].status, 'solapa')
  const allowed = buildPlan([target('A', 60, 9 * 60 + 30)], [existing('Otra', 9 * 60, 10 * 60)], {
    ...OPTIONS,
    allowOverlap: true,
  })
  assert.equal(allowed[0].status, 'nueva')
})

test('marca lo que no cabe en el día', () => {
  const plan = buildPlan([target('Larga', 15 * 60), target('Noche', 120, 23 * 60)], [], OPTIONS)
  assert.equal(plan[0].status, 'no-cabe')
  assert.equal(plan[1].status, 'no-cabe')
})

test('sin almuerzo llena de corrido y cada día se planifica aparte', () => {
  const plan = buildPlan([target('A', 240), target('B', 60, null, '2026-11-11')], [], { ...OPTIONS, lunch: null })
  assert.deepEqual(blocks(plan[0]), [[9, 13]])
  assert.deepEqual(blocks(plan[1]), [[9, 10]])
})

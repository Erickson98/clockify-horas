import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDay, formatDuration, localParts, localToEpoch, toApiDate } from '../src/time.ts'

test('localToEpoch convierte la hora local de Santo Domingo a UTC', () => {
  assert.equal(toApiDate(localToEpoch('2026-11-10', 9 * 60, 'America/Santo_Domingo')), '2026-11-10T13:00:00Z')
  assert.equal(toApiDate(localToEpoch('2026-11-10', 22 * 60, 'America/Santo_Domingo')), '2026-11-11T02:00:00Z')
  assert.equal(toApiDate(localToEpoch('2026-11-10', 24 * 60, 'America/Santo_Domingo')), '2026-11-11T04:00:00Z')
})

test('localToEpoch respeta el horario de verano', () => {
  assert.equal(toApiDate(localToEpoch('2026-03-08', 9 * 60, 'America/New_York')), '2026-03-08T13:00:00Z')
  assert.equal(toApiDate(localToEpoch('2026-03-07', 9 * 60, 'America/New_York')), '2026-03-07T14:00:00Z')
  assert.equal(toApiDate(localToEpoch('2026-07-01', 9 * 60, 'Europe/Madrid')), '2026-07-01T07:00:00Z')
})

test('localParts devuelve fecha y minutos locales', () => {
  assert.deepEqual(localParts(Date.parse('2026-11-11T02:30:00Z'), 'America/Santo_Domingo'), {
    date: '2026-11-10',
    minutes: 22 * 60 + 30,
    seconds: 0,
  })
})

test('formatos para la tabla', () => {
  assert.equal(formatDay('2026-11-10'), 'mar 10/11')
  assert.equal(formatDuration(150), '2h 30m')
  assert.equal(formatDuration(120), '2h')
  assert.equal(formatDuration(45), '45m')
})

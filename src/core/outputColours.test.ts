import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collapsed, keyValueLines, valueTone } from './outputColours.ts'

const SCHEMA = `COLUMNS:
  id: string
  survey_id: bigint
  obs: struct<a:int,b:double>

SAMPLE DATA:
  Row 1:
    id: 01M79T4W08VK3MHXY5PGC7D32J
    survey_id: 85422741
    lift_reason:
    quarantined_at: 2026-11-12T08:50:01.147
`

test('a schema reads as headings, keys and toned values, with blank lines kept', () => {
  const lines = keyValueLines(SCHEMA)
  assert.ok(lines)
  assert.deepEqual(lines[0], [{ text: 'COLUMNS:', tone: 'heading' }])
  assert.deepEqual(lines[1], [{ text: '  ' }, { text: 'id', tone: 'key' }, { text: ':' }, { text: ' ' }, { text: 'string', tone: 'type' }])
  assert.equal(lines[3]?.[4]?.tone, 'type')
  assert.deepEqual(lines[4], [])
  assert.deepEqual(lines[6], [{ text: '  Row 1:', tone: 'heading' }])
  assert.equal(lines[7]?.[4]?.tone, undefined)
  assert.equal(lines[8]?.[4]?.tone, 'number')
  assert.deepEqual(lines[9], [{ text: '    ' }, { text: 'lift_reason', tone: 'key' }, { text: ':' }])
  assert.equal(lines[10]?.[4]?.tone, 'time')
  assert.equal(lines.length, 11)
})

test('output that is mostly not key: value lines keeps its usual look', () => {
  assert.equal(keyValueLines('a: 1\nb: 2'), undefined)
  assert.equal(keyValueLines('a: 1\nb: 2\nc: 3\nplain\nplain\nplain'), undefined)
  assert.ok(keyValueLines('a: 1\nb: 2\nc: 3\nplain\nplain'))
  assert.equal(keyValueLines('total 8\ndrwxr-xr-x  2 me  staff  64 Nov 13 x\n'), undefined)
})

test('values take a tone by what they look like', () => {
  const cases: [string, string | undefined][] = [
    ['timestamp_ntz', 'type'], ['decimal(10, 2)', 'type'], ['array<string>', 'type'], ['-3.5', 'number'], ['true', 'literal'],
    ['None', 'literal'], ['2026-11-13', 'time'], ['2026-11-13 09:30:00', 'time'], ['{"value":"1.00"}', 'muted'], ['[1, 2]', 'muted'],
    ['cint_exchange', undefined], ['12 rows', undefined],
  ]
  for (const [value, tone] of cases) assert.equal(valueTone(value), tone, value)
})

test('a folded view shows the first lines and counts the rest', () => {
  assert.deepEqual(collapsed([1, 2, 3], 5), { shown: [1, 2, 3], hidden: 0 })
  assert.deepEqual(collapsed([1, 2, 3, 4], 2), { shown: [1, 2], hidden: 2 })
})

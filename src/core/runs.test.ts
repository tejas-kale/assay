import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCsv, parseRunStatus, parseRuns } from './runs.ts'

test('parseRuns pairs code and data by number, oldest first, and ignores other files', () => {
  const runs = parseRuns(['020_b.csv', '020_b.sql', '007_a.sql', '021_plot.py', 'notes.md', '.hidden', 'x_y.sql'])
  assert.deepEqual(runs, [
    { number: 7, label: '007', slug: 'a', code: '007_a.sql', language: 'sql' },
    { number: 20, label: '020', slug: 'b', code: '020_b.sql', data: '020_b.csv', language: 'sql' },
    { number: 21, label: '021', slug: 'plot', code: '021_plot.py', language: 'python' },
  ])
})

test('a result with no code file is still a run', () => {
  assert.deepEqual(parseRuns(['003_x.csv']), [{ number: 3, label: '003', slug: 'x', data: '003_x.csv' }])
})

test('parseCsv reads quotes, doubled quotes, embedded commas and newlines, and CRLF', () => {
  const table = parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",\n', 10)
  assert.deepEqual(table, { columns: ['a', 'b'], rows: [['x, y', 'say "hi"'], ['two\nlines', '']], truncated: false })
})

test('parseCsv stops at maxRows and says so', () => {
  assert.deepEqual(parseCsv('a\n1\n2\n3\n', 2), { columns: ['a'], rows: [['1'], ['2']], truncated: true })
  assert.deepEqual(parseCsv('a\n1\n2\n', 2), { columns: ['a'], rows: [['1'], ['2']], truncated: false })
  assert.deepEqual(parseCsv('a\n1\n2', 2), { columns: ['a'], rows: [['1'], ['2']], truncated: false })
})

test('parseCsv of an empty file has no columns', () => {
  assert.deepEqual(parseCsv('', 5), { columns: [], rows: [], truncated: false })
})

test('parseRunStatus reads the running query and failures, and shrugs off junk', () => {
  assert.deepEqual(parseRunStatus('{"running":{"number":21,"startedAt":5},"failed":{"7":"boom","x":"no","8":3}}'), {
    running: { number: 21, startedAt: 5 },
    failed: { 7: 'boom' },
  })
  assert.deepEqual(parseRunStatus('{"running":null,"failed":{}}'), { failed: {} })
  for (const junk of ['', 'nope', 'null', '[]']) assert.deepEqual(parseRunStatus(junk), { failed: {} })
})

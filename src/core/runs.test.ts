import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCsv, parseRunHeader, parseRunStatus, parseRuns, runLabel, sqlBody } from './runs.ts'

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

test('parseRunHeader reads author, origin, trusted name and engine from the leading comments', () => {
  assert.deepEqual(parseRunHeader('-- author: user\n-- from: 012\n-- postgres\nselect 1\n'), {
    author: 'user',
    from: 12,
    engine: 'postgres',
  })
  assert.deepEqual(parseRunHeader('-- trusted: weekly\n-- args: {"a":1}\n-- commit: abc\nselect 1'), {
    author: 'claude',
    trusted: 'weekly',
    engine: 'databricks',
  })
  assert.deepEqual(parseRunHeader('select 1'), { author: 'claude', engine: 'databricks' })
})

test('parseRunHeader ignores header-looking lines after the SQL starts', () => {
  assert.deepEqual(parseRunHeader('select 1\n-- author: user\n-- postgres'), { author: 'claude', engine: 'databricks' })
})

test('sqlBody drops the leading header lines and keeps other comments', () => {
  const text = '-- author: user\n-- from: 012\n-- postgres\n-- why we count\nselect 1\n-- postgres\n'
  assert.equal(sqlBody(text), '-- why we count\nselect 1\n-- postgres\n')
  assert.equal(sqlBody('-- trusted: w\n-- args: {}\n-- commit: x\nselect 2'), 'select 2')
  assert.equal(sqlBody('select 3'), 'select 3')
})

test('runLabel: running wins, no csv is unverified, a trusted header is trusted, else queried', () => {
  const header = { author: 'claude', engine: 'databricks' } as const
  const run = { number: 5, label: '005', slug: 's', code: '005_s.sql', data: '005_s.csv' }
  assert.equal(runLabel(run, header, { failed: {} }), 'queried')
  assert.equal(runLabel(run, { ...header, trusted: 'w' }, { failed: {} }), 'trusted')
  assert.equal(runLabel({ ...run, data: undefined }, { ...header, trusted: 'w' }, { failed: {} }), 'unverified')
  assert.equal(runLabel(run, header, { running: { number: 5, startedAt: 1 }, failed: {} }), 'running')
  assert.equal(runLabel(run, header, { running: { number: 6, startedAt: 1 }, failed: {} }), 'queried')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { citedLabel, codeBody, runningPythonRun, parseCsv, parseRunHeader, parseRunResult, parseRunStatus, parseRuns, runLabel, withoutHeaderLines } from './runs.ts'

test('parseRuns pairs code and data by number, oldest first, and ignores other files', () => {
  const runs = parseRuns(['020_b.csv', '020_b.sql', '007_a.sql', '021_plot.py', 'notes.md', '.hidden', 'x_y.sql'])
  assert.deepEqual(runs, [
    { number: 7, label: '007', slug: 'a', code: '007_a.sql', language: 'sql', tables: [], plots: [] },
    { number: 20, label: '020', slug: 'b', code: '020_b.sql', data: '020_b.csv', language: 'sql', tables: [], plots: [] },
    { number: 21, label: '021', slug: 'plot', code: '021_plot.py', language: 'python', tables: [], plots: [] },
  ])
})

test('a result with no code file is still a run', () => {
  assert.deepEqual(parseRuns(['003_x.csv']), [{ number: 3, label: '003', slug: 'x', data: '003_x.csv', tables: [], plots: [] }])
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

test('codeBody drops the leading header lines and keeps other comments', () => {
  const text = '-- author: user\n-- from: 012\n-- postgres\n-- why we count\nselect 1\n-- postgres\n'
  assert.equal(codeBody(text, 'sql'), '-- why we count\nselect 1\n-- postgres\n')
  assert.equal(codeBody('-- trusted: w\n-- args: {}\n-- commit: x\nselect 2', 'sql'), 'select 2')
  assert.equal(codeBody('select 3', 'sql'), 'select 3')
})

test('runLabel: running wins, no csv is unverified, a trusted header is trusted, else queried', () => {
  const header = { author: 'claude', engine: 'databricks' } as const
  const run = { number: 5, label: '005', slug: 's', code: '005_s.sql', data: '005_s.csv', tables: [], plots: [] }
  assert.equal(runLabel(run, header, { failed: {} }), 'queried')
  assert.equal(runLabel(run, { ...header, trusted: 'w' }, { failed: {} }), 'trusted')
  assert.equal(runLabel({ ...run, data: undefined }, { ...header, trusted: 'w' }, { failed: {} }), 'unverified')
  assert.equal(runLabel(run, header, { running: { number: 5, startedAt: 1 }, failed: {} }), 'running')
  assert.equal(runLabel(run, header, { running: { number: 6, startedAt: 1 }, failed: {} }), 'queried')
})

test('parseRuns reads Python runs with their result, tables and plots in K order', () => {
  const runs = parseRuns([
    '012_x.py', '012_x.json', '012_x.t2.csv', '012_x.t1.csv', '012_x.t10.csv', '012_x.p1.png', '012_x.p2.svg', '.012_x.json.tmp',
  ])
  assert.deepEqual(runs, [
    {
      number: 12, label: '012', slug: 'x', code: '012_x.py', language: 'python', result: '012_x.json',
      tables: ['012_x.t1.csv', '012_x.t2.csv', '012_x.t10.csv'], plots: ['012_x.p1.png', '012_x.p2.svg'],
    },
  ])
})

test('a table file is never a SQL result, even when it comes first', () => {
  const [run, ...rest] = parseRuns(['012_x.t1.csv', '012_x.csv', '012_x.sql'])
  assert.equal(rest.length, 0)
  assert.ok(run)
  assert.equal(run.data, '012_x.csv')
  assert.deepEqual(run.tables, ['012_x.t1.csv'])
  assert.equal(parseRuns(['012_x.t1.csv'])[0]?.data, undefined)
})

test('parseRunStatus reads the kernel and ignores a bad one', () => {
  assert.deepEqual(parseRunStatus('{"failed":{},"kernel":{"state":"missing","message":"Add ipykernel"}}'), {
    failed: {},
    kernel: { state: 'missing', message: 'Add ipykernel' },
  })
  assert.deepEqual(parseRunStatus('{"kernel":{"state":"idle"}}'), { failed: {}, kernel: { state: 'idle' } })
  assert.deepEqual(parseRunStatus('{"kernel":{"state":"weird"}}'), { failed: {} })
  assert.deepEqual(parseRunStatus('{"kernel":3}'), { failed: {} })
})

test('parseRunHeader reads a Python header: author, from, replay', () => {
  assert.deepEqual(parseRunHeader('# author: user\n# from: 012\ndf = q(12)\n# author: claude', 'python'), {
    author: 'user',
    from: 12,
    engine: 'databricks',
  })
  assert.deepEqual(parseRunHeader('# author: user\n# replay: 014\nx = 1', 'python'), {
    author: 'user',
    replay: 14,
    engine: 'databricks',
  })
  assert.deepEqual(parseRunHeader('x = 1', 'python'), { author: 'claude', engine: 'databricks' })
  assert.deepEqual(parseRunHeader('-- author: user\nselect 1'), { author: 'user', engine: 'databricks' })
})

test('codeBody strips Python header lines only at the top', () => {
  const text = '# author: user\n# from: 012\n# replay: 3\n# keep me\nx = 1\n# from: 5\n'
  assert.equal(codeBody(text, 'python'), '# keep me\nx = 1\n# from: 5\n')
  assert.equal(codeBody('-- author: user\nselect 1', 'sql'), 'select 1')
  assert.equal(codeBody('# author: user\nselect 1', 'sql'), '# author: user\nselect 1')
})

test('parseRunResult reads a result, ignores unknown fields, and is undefined when unreadable', () => {
  const text = JSON.stringify({
    status: 'ok', kernel: 'k1', startedAt: 1, endedAt: 5, stdout: 'hi\n', stdoutTruncated: true, extra: 1,
    error: { name: 'KeyError', message: "'x'", traceback: 'tb' },
    tables: [{ file: '014_x.t1.csv', columns: ['a'], rowCount: 12000, truncated: true }],
    plots: [{ file: '014_x.p1.png' }], reads: [12, 'x'],
  })
  assert.deepEqual(parseRunResult(text), {
    status: 'ok', kernel: 'k1', startedAt: 1, endedAt: 5, stdout: 'hi\n', stdoutTruncated: true,
    error: { name: 'KeyError', message: "'x'", traceback: 'tb' },
    tables: [{ file: '014_x.t1.csv', columns: ['a'], rowCount: 12000, truncated: true }],
    plots: ['014_x.p1.png'], reads: [12],
  })
  assert.deepEqual(parseRunResult('{"status":"running"}'), { status: 'running', stdout: '', tables: [], plots: [], reads: [] })
  for (const junk of ['', 'nope', '[]', 'null', '{"status":"weird"}', '{}', '{"status":"ok"']) {
    assert.equal(parseRunResult(junk), undefined, junk)
  }
})

test('runLabel for Python: ok is computed, anything else unverified, running still wins', () => {
  const header = { author: 'claude', engine: 'databricks' } as const
  const run = { number: 9, label: '009', slug: 'p', code: '009_p.py', language: 'python', result: '009_p.json', tables: [], plots: [] } as const
  const none = { failed: {} }
  assert.equal(runLabel({ ...run, status: 'ok' }, header, none), 'computed')
  for (const status of ['error', 'interrupted', 'running'] as const) assert.equal(runLabel({ ...run, status }, header, none), 'unverified')
  assert.equal(runLabel(run, header, none), 'unverified')
  assert.equal(runLabel({ ...run, status: 'ok' }, header, { running: { number: 9, startedAt: 1 }, failed: {} }), 'running')
})

test('citedLabel: what a note citing a run gets', () => {
  const statusOf = (number: number) => {
    if (number === 3) return { status: 'ok' as const }
    return number === 4 ? { status: 'error' as const } : {}
  }
  const runs = parseRuns(['001_a.sql', '001_a.csv', '002_b.sql', '003_c.py', '004_d.py']).map(r => ({ ...r, ...statusOf(r.number) }))
  const of = citedLabel(runs)
  assert.deepEqual([of(1), of(2), of(3), of(4), of(99)], ['queried', 'unverified', 'computed', 'unverified', 'unverified'])
})

test('runningPythonRun finds the Python run the mod says is running, and nothing for SQL or none', () => {
  const runs = parseRuns(['001_a.sql', '002_b.py'])
  assert.equal(runningPythonRun(runs, { running: { number: 2, startedAt: 1 }, failed: {} })?.number, 2)
  assert.equal(runningPythonRun(runs, { running: { number: 1, startedAt: 1 }, failed: {} }), undefined)
  assert.equal(runningPythonRun(runs, { failed: {} }), undefined)
  assert.equal(runningPythonRun(runs, { running: { number: 9, startedAt: 1 }, failed: {} }), undefined)
})

test('citedLabel: unknown run unverified, SQL with data queried, Python ok computed, never trusted', () => {
  const sql = { number: 1, label: '001', slug: 'a', code: '001_a.sql', language: 'sql', tables: [], plots: [], data: '001_a.csv' } as const
  const label = citedLabel([sql, { ...sql, number: 2, data: undefined }, { ...sql, number: 3, language: 'python', status: 'ok' }, { ...sql, number: 4, language: 'python', status: 'error' }])
  assert.deepEqual([1, 2, 3, 4, 9].map(label), ['queried', 'unverified', 'computed', 'unverified', 'unverified'])
})

test('a run with includes names what it is built from, and a re-run drops the line', () => {
  const text = '-- author: user\n-- built from: client_entry_sessions@1a2b3c4d5e6f, a:b@ffff\n-- grain: x\nSELECT 1\n'
  assert.deepEqual(parseRunHeader(text).builtFrom, ['client_entry_sessions@1a2b3c4d5e6f', 'a:b@ffff'])
  assert.equal(codeBody(text, 'sql'), '-- grain: x\nSELECT 1\n')
})

test('parseCsv: lone carriage returns end records, blank lines vanish, and a quote starts a quoted run anywhere in a field', () => {
  assert.deepEqual(parseCsv('a,b\r1,2\r\r\n\n3,4', 10), { columns: ['a', 'b'], rows: [['1', '2'], ['3', '4']], truncated: false })
  assert.deepEqual(parseCsv('x"a,b"y,z\n', 10), { columns: ['xa,by', 'z'], rows: [], truncated: false })
  assert.deepEqual(parseCsv('a,"b\n1', 10), { columns: ['a', 'b\n1'], rows: [], truncated: false })
  assert.deepEqual(parseCsv('a,b\n1,', 10), { columns: ['a', 'b'], rows: [['1', '']], truncated: false })
  assert.deepEqual(parseCsv('a\n"",\n', 10), { columns: ['a'], rows: [['', '']], truncated: false })
  assert.deepEqual(parseCsv('"a""\n', 10), { columns: ['a"\n'], rows: [], truncated: false })
})

test('parseCsv: only a row left unread counts as truncated, at any row limit', () => {
  assert.deepEqual(parseCsv('a\n1\n2', 1), { columns: ['a'], rows: [['1']], truncated: true })
  assert.deepEqual(parseCsv('a\n1\r\n', 1), { columns: ['a'], rows: [['1']], truncated: false })
  assert.deepEqual(parseCsv('a\n1\n\n', 1), { columns: ['a'], rows: [['1']], truncated: true }, 'any text after the last row counts, even a blank line')
  assert.deepEqual(parseCsv('a\n1\n2\n', 0), { columns: ['a'], rows: [], truncated: true })
  assert.deepEqual(parseCsv('a', 0), { columns: ['a'], rows: [], truncated: false })
  assert.deepEqual(parseCsv('a\nb\n', -1), { columns: [], rows: [], truncated: true })
})

test('parseRunHeader: SQL comments, in any order, until the first line that is not a comment', () => {
  const text = '-- trusted:  weekly extra\n-- why\n-- built from: a@1,, b@2 ,\n-- postgres  \n-- from: x\n-- from: 007\n--author: user\nselect 1\n-- from: 9'
  assert.deepEqual(parseRunHeader(text), { author: 'claude', trusted: 'weekly', builtFrom: ['a@1', 'b@2'], engine: 'postgres', from: 7 })
  assert.deepEqual(parseRunHeader('-- trusted: \n-- built from: \n-- postgres x'), { author: 'claude', engine: 'databricks' })
  assert.deepEqual(parseRunHeader('# author: user\n-- postgres', 'sql'), { author: 'claude', engine: 'databricks' })
  assert.deepEqual(parseRunHeader('# from: 1\n# replay: x\n# replay: 2\n-- postgres', 'python'), { author: 'claude', from: 1, replay: 2, engine: 'databricks' })
  assert.deepEqual(parseRunHeader('', 'python'), { author: 'claude', engine: 'databricks' })
})

test('parseRunStatus: a running entry needs both numbers, failures need a digit key, a kernel message must not be empty', () => {
  assert.deepEqual(parseRunStatus('{"running":{"number":1},"failed":{"01":"a","1x":"b"}}'), { failed: { 1: 'a' } })
  assert.deepEqual(parseRunStatus('{"running":{"startedAt":1},"failed":[]}'), { failed: {} })
  assert.deepEqual(parseRunStatus('{"kernel":{"state":"dead","message":""}}'), { failed: {}, kernel: { state: 'dead' } })
  assert.deepEqual(parseRunStatus('{"kernel":{"state":"busy","message":5}}'), { failed: {}, kernel: { state: 'busy' } })
  assert.deepEqual(parseRunStatus('{"kernel":null,"running":3,"failed":"x"}'), { failed: {} })
})

test('parseRunResult: a table needs a file name, a plot an object with one, and every text field falls back to empty', () => {
  const text = JSON.stringify({
    status: 'error', stdout: 5, kernel: 1, startedAt: '1', endedAt: null, stdoutTruncated: false, error: {},
    tables: [{ file: 't.csv' }, { file: 3 }, 'x', null, { file: 'u.csv', columns: ['a', 2], rowCount: '3', truncated: 'yes' }],
    plots: ['p.png', { file: 3 }, { file: 'q.png' }, null], reads: 'x',
  })
  assert.deepEqual(parseRunResult(text), {
    status: 'error', stdout: '', error: { name: '', message: '', traceback: '' },
    tables: [{ file: 't.csv', columns: [], rowCount: 0, truncated: false }, { file: 'u.csv', columns: ['a'], rowCount: 0, truncated: false }],
    plots: ['q.png'], reads: [],
  })
  assert.deepEqual(parseRunResult('{"status":"ok","error":"x","tables":{},"plots":{}}'), { status: 'ok', stdout: '', tables: [], plots: [], reads: [] })
})

test("withoutHeaderLines drops header-shaped lines from the leading comments only (audit PI-3)", () => {
  assert.equal(withoutHeaderLines('# author: user\n# replay: 3\n# a note\nprint(1)\n# author: user', 'python'), '# a note\nprint(1)\n# author: user')
  assert.deepEqual(parseRunHeader(withoutHeaderLines('# author: user\nprint(1)', 'python'), 'python'), { author: 'claude', engine: 'databricks' })
  assert.equal(withoutHeaderLines('SELECT 1', 'sql'), 'SELECT 1')
  assert.equal(withoutHeaderLines('-- postgres\n-- built from: x@1', 'sql'), '')
})

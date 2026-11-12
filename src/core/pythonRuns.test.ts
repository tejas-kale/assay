import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PythonRun } from './pythonRuns.ts'
import { cut, formatPythonRun, formatTable, parsePythonRun, pythonBody, pythonHeader, queryLabel, runSlug, splitKernelEvents, toCsv, venvCandidates } from './pythonRuns.ts'

test('a run slug is lower case, dashes between runs of other characters, 48 characters at most, or query', () => {
  assert.equal(runSlug('Daily Users, by Region!'), 'daily-users-by-region')
  assert.equal(runSlug('--__x__--'), 'x')
  assert.equal(runSlug('---'), 'query')
  assert.equal(runSlug(''), 'query')
  assert.equal(runSlug('é'), 'query')
  assert.equal(runSlug('a'.repeat(60)), 'a'.repeat(48))
  assert.equal(runSlug(`${'a'.repeat(46)}--bcd`), `${'a'.repeat(46)}-b`)
  assert.equal(runSlug(`${'a'.repeat(47)}--bcd`), 'a'.repeat(47))
})

test('queryLabel pads to three digits, cut flattens whitespace and ends a long text with an ellipsis', () => {
  assert.equal(queryLabel(7), '007')
  assert.equal(queryLabel(1234), '1234')
  assert.equal(cut('a  b\n\tc', 10), 'a b c')
  assert.equal(cut('abcdef', 4), 'abc…')
  assert.equal(cut('abcd', 4), 'abcd')
  assert.equal(cut('abc', 0), '…')
})

test('csv quotes cells holding a quote, a comma or a line break', () => {
  assert.equal(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['1\n2', 'r\r']]), 'a,b\n"x,y","say ""hi"""\n"1\n2","r\r"\n')
})

test('a table pads all but the last column, and cuts wide cells', () => {
  assert.equal(formatTable(['name', 'n'], [['alpha', '1'], ['b', '22']], 80), 'name   n\nalpha  1\nb      22')
  assert.equal(formatTable(['a'], [['x'.repeat(10)]], 5), 'a\nxxxx…')
  assert.equal(formatTable(['a', 'b'], [['1']], 80), 'a  b\n1')
})

test('kernel events: ready needs a numeric pid, dead and missing get a default message, strays are ignored', () => {
  const lines = [
    '{"event":"ready","kernel":"py3","pid":4}',
    '{"event":"ready","pid":5}',
    '{"event":"ready","pid":"6"}',
    '{"event":"interrupted","extra":1}',
    '{"event":"stopped"}',
    '{"event":"dead","message":"gone"}',
    '{"event":"dead"}',
    '{"event":"missing","message":3}',
    '{"event":"other"}',
    'null',
    '7',
    'not json',
    '',
    '{"event":"stopped"',
  ].join('\n')
  assert.deepEqual(splitKernelEvents(lines), {
    events: [
      { event: 'ready', kernel: 'py3', pid: 4 },
      { event: 'ready', kernel: '', pid: 5 },
      { event: 'interrupted' },
      { event: 'stopped' },
      { event: 'dead', message: 'gone' },
      { event: 'dead', message: 'The kernel is dead.' },
      { event: 'missing', message: 'The kernel is missing.' },
    ],
    rest: '{"event":"stopped"',
  })
  assert.deepEqual(splitKernelEvents(''), { events: [], rest: '' })
})

test('the runner output is its last non-empty line, and a bad one says what it printed', () => {
  assert.deepEqual(parsePythonRun(''), { error: 'The kernel runner printed nothing.' })
  assert.deepEqual(parsePythonRun('  \n\n'), { error: 'The kernel runner printed nothing.' })
  assert.deepEqual(parsePythonRun('Traceback\n  oops'), { error: 'The kernel runner printed:  oops' })
  assert.deepEqual(parsePythonRun('null'), { error: 'The kernel runner gave no status: null' })
  assert.deepEqual(parsePythonRun('{"status":"weird"}'), { error: 'The kernel runner gave no status: {"status":"weird"}' })
  assert.deepEqual(parsePythonRun('noise\n\n{"status":"ok"}\n\n'), { status: 'ok', stdout: '', tables: [], plots: [], reads: [] })
})

test('the runner output keeps well-formed tables, plots and reads, and drops the rest', () => {
  const body = {
    status: 'error',
    stdout: 'hi',
    error: { name: 'KeyError', message: 'x', traceback: 'tb' },
    durationMs: 1500,
    tables: [
      { file: 'a.csv', columns: ['c', 2], rows: [[1, 'x'], 'bad', [null]], rowCount: 9, truncated: true },
      { file: 'b.csv', rows: 'nope', columns: 'nope', rowCount: '3', truncated: 'yes' },
      { file: 'c.csv', rows: [['1']] },
      { columns: [] },
      null,
      5,
    ],
    plots: ['p1.png', { file: 'p2.png' }, { file: 3 }, { name: 'p3.png' }, null, 7],
    reads: [3, '4', 5, null],
  }
  assert.deepEqual(parsePythonRun(JSON.stringify(body)), {
    status: 'error',
    stdout: 'hi',
    error: { name: 'KeyError', message: 'x', traceback: 'tb' },
    tables: [
      { file: 'a.csv', columns: ['c', '2'], rows: [['1', 'x'], [], ['null']], rowCount: 9, truncated: true },
      { file: 'b.csv', columns: [], rows: [], rowCount: 0, truncated: false },
      { file: 'c.csv', columns: [], rows: [['1']], rowCount: 1, truncated: false },
    ],
    plots: ['p1.png', 'p2.png'],
    reads: [3, 5],
    durationMs: 1500,
  })
  assert.deepEqual(parsePythonRun('{"status":"interrupted","stdout":5,"error":"x","tables":"t","plots":{},"reads":"r"}'), {
    status: 'interrupted', stdout: '', tables: [], plots: [], reads: [],
  })
  assert.deepEqual(parsePythonRun('{"status":"ok","error":null,"durationMs":"1"}'), { status: 'ok', stdout: '', tables: [], plots: [], reads: [] })
})

const base: PythonRun = { status: 'ok', stdout: '', tables: [], plots: [], reads: [] }

test('a Python reply shows the measured time over the wall time, the traceback tail or the error name and message', () => {
  assert.equal(formatPythonRun(3, { ...base, durationMs: 400 }, 9000), 'Run 003: ok (0.4 s).')
  const traceback = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n')
  const lines = formatPythonRun(3, { ...base, status: 'error', error: { traceback } }, 0).split('\n')
  assert.equal(lines.length, 31)
  assert.equal(lines[1], 'line 10')
  assert.equal(formatPythonRun(3, { ...base, status: 'error', error: { name: 'E', message: 'm' } }, 0).split('\n')[1], 'E: m')
  assert.equal(formatPythonRun(3, { ...base, status: 'error', error: { message: 'm' } }, 0).split('\n')[1], 'm')
  assert.equal(formatPythonRun(3, { ...base, status: 'error', error: {} }, 0), 'Run 003: error (0.0 s).\n')
})

test('a Python reply lists each table with its file and row count, and says when rows were cut', () => {
  const rows = Array.from({ length: 60 }, (_, i) => [String(i)])
  const run: PythonRun = {
    ...base,
    tables: [
      { file: 't1.csv', columns: ['n'], rows, rowCount: 60, truncated: false },
      { file: 't2.csv', columns: ['n'], rows: rows.slice(0, 1), rowCount: 1, truncated: false },
      { file: 't3.csv', columns: ['n', 'm'], rows: [], rowCount: 200000, truncated: true },
    ],
    plots: ['p.png'],
  }
  const text = formatPythonRun(1, run, 0, { queriesDir: 'q', maxCell: 5 }).split('\n')
  assert.equal(text[1], 'Table 1 (q/t1.csv): 60 rows. Columns: n')
  assert.ok(text.includes('Truncated: showing 50 of 60 rows. q/t1.csv has all of them.'))
  assert.ok(text.includes('Table 2 (q/t2.csv): 1 row. Columns: n'))
  assert.ok(text.includes('Table 3 (q/t3.csv): 200000 rows. Columns: n, m'))
  assert.ok(text.includes('Truncated: showing 0 of 200000 rows. q/t3.csv has the first 100000 of them.'))
  assert.equal(text.at(-1), 'Plot: q/p.png (Read it to check the chart.)')
  assert.ok(formatPythonRun(1, { ...base, stdout: 'out \n' }, 0).includes('\nout'))
})

test('Python header lines are written in order and stripped only at the top, whole lines at a time', () => {
  assert.equal(pythonHeader({}), '')
  assert.equal(pythonHeader({ author: 'user', from: 4, replay: 12 }), '# author: user\n# from: 004\n# replay: 012\n')
  assert.equal(pythonHeader({ from: 0 }), '')
  assert.equal(pythonBody('# author: user\n# from: 004\nx = 1\n# from: 005\n'), 'x = 1\n# from: 005\n')
  assert.equal(pythonBody('# author: user'), '# author: user')
  assert.equal(pythonBody('# other: x\n# from: 1\n'), '# other: x\n# from: 1\n')
  assert.equal(pythonBody('# from:\n\n# from: 2\n'), '\n# from: 2\n')
})

test('venv candidates walk from the folder up to the root, nearest first', () => {
  assert.deepEqual(venvCandidates('/a/b'), ['/a/b/.venv/bin/python', '/a/.venv/bin/python', '/.venv/bin/python'])
  assert.deepEqual(venvCandidates('/'), ['/.venv/bin/python'])
  assert.deepEqual(venvCandidates('//a//'), ['/a/.venv/bin/python', '/.venv/bin/python'])
})

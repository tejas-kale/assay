// The analysis mod's model tests (config b2f7df2, claude/analysis/tests/model.test.ts), ported to the core
// functions the server uses. The pane's tests (layout, SQL folding, transposing) went with the pane.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { BASH_PYTHON_DENY, bashRunsPython } from './bashGuard.ts'
import { parseCliOutput, parsePsqlOutput, readTarget } from './engines.ts'
import type { PythonRun } from './pythonRuns.ts'
import { formatPythonRun, formatTable, parsePythonRun, pythonBody, pythonHeader, runSlug, splitKernelEvents, toCsv, venvCandidates } from './pythonRuns.ts'
import { isUrgent, parseRequestFile } from './requests.ts'
import type { ServerRequest } from './requests.ts'
import { analysisRules, runNotice } from './rules.ts'
import { nextRunNumber, parseRunHeader, parseRunResult, parseRuns } from './runs.ts'
import { closeThread, focusThread, formatThreads, orderThreads, parkThread, parseThreads } from './threads.ts'

const statusOf = (text: string) => parseRunResult(text)?.status

const THREADS = `## Open
1. Why do some panels have alpha = 0?
2. Is \`completion_rate\` per respondent or per survey?

## Closed
- Does \`is_test\` exclude internal traffic? → yes, filter in all queries
- Is the table partitioned?
`

test('threads.md parses and formats back unchanged', () => {
  const threads = parseThreads(THREADS)
  expect(threads.open).toEqual([
    'Why do some panels have alpha = 0?',
    'Is `completion_rate` per respondent or per survey?',
  ])
  expect(threads.closed).toEqual([
    { thread: 'Does `is_test` exclude internal traffic?', outcome: 'yes, filter in all queries' },
    { thread: 'Is the table partitioned?' },
  ])
  expect(formatThreads(threads)).toBe(THREADS)
})

test('an empty threads.md is no threads', () => {
  expect(parseThreads('')).toEqual({ open: [], closed: [] })
  expect(formatThreads({ open: [], closed: [] })).toBe('## Open\n\n## Closed\n')
})

test('park appends to the open list', () => {
  const threads = parkThread(parseThreads(''), '  Why is beta null?\n')
  expect(threads.open).toEqual(['Why is beta null?'])
})

test('close matches by number, exact text or a unique part', () => {
  const threads = parseThreads(THREADS)

  const byNumber = closeThread(threads, '2', 'per respondent')
  expect(byNumber.closed?.thread).toBe('Is `completion_rate` per respondent or per survey?')
  expect(byNumber.threads.open).toEqual(['Why do some panels have alpha = 0?'])
  expect(byNumber.threads.closed.at(-1)).toEqual({
    thread: 'Is `completion_rate` per respondent or per survey?',
    outcome: 'per respondent',
  })

  expect(closeThread(threads, 'why do some panels have alpha = 0?').closed?.thread).toBe(
    'Why do some panels have alpha = 0?',
  )
  expect(closeThread(threads, 'alpha').closed?.thread).toBe('Why do some panels have alpha = 0?')
  expect(closeThread(threads, 'nothing like it').error).toMatch(/No open thread/)
  expect(closeThread(threads, '?').error).toMatch(/2 open threads match/)
  expect(closeThread(threads, '7').error).toMatch(/No open thread/)
})

test('focus moves the named open thread to the top, keeping the rest in order', () => {
  const threads = parseThreads(THREADS)
  const focused = focusThread(threads, 'completion')
  expect(focused.focused).toBe('Is `completion_rate` per respondent or per survey?')
  expect(focused.threads.open).toEqual([
    'Is `completion_rate` per respondent or per survey?',
    'Why do some panels have alpha = 0?',
  ])
  expect(focused.threads.closed).toEqual(threads.closed)
  expect(focusThread(threads, '1').threads).toBe(threads)
  expect(focusThread(threads, '?').error).toMatch(/2 open threads match/)
})

test('order moves the named threads to the top in turn, the rest keep their order', () => {
  const threads = parseThreads('## Open\n1. A?\n2. B?\n3. C?\n4. D?\n')
  expect(orderThreads(threads, ['4', 'B?']).threads.open).toEqual(['D?', 'B?', 'A?', 'C?'])
  expect(orderThreads(threads, ['9']).error).toMatch(/No open thread/)
  expect(orderThreads(threads, ['2', 'b?']).error).toMatch(/already listed/)
  expect(orderThreads(threads, ['9']).threads).toBe(threads)
})

test('query files are numbered after the highest one', () => {
  expect(nextRunNumber([])).toBe(1)
  expect(nextRunNumber(['001_a.sql', '001_a.csv', '009_b.sql', 'notes.txt'])).toBe(10)
  expect(parseRuns(['012_beta-params.sql'])).toMatchObject([{ number: 12, slug: 'beta-params', code: '012_beta-params.sql', language: 'sql' }])
  expect(parseRuns(['readme.md'])).toEqual([])
})

test('Python run files are named like SQL ones; tables and plots belong to their run', () => {
  expect(nextRunNumber(['003_a.sql', '004_b.py', '004_b.json', '004_b.t1.csv', '004_b.p1.png'])).toBe(5)
  expect(nextRunNumber(['014_x.t1.csv'])).toBe(15)
  const [run] = parseRuns(['014_x.py', '014_x.json', '014_x.t2.csv', '014_x.p1.png', '014_x.p3.svg', '014_x.png'])
  expect(run).toMatchObject({ number: 14, slug: 'x', code: '014_x.py', result: '014_x.json', language: 'python', tables: ['014_x.t2.csv'], plots: ['014_x.p1.png', '014_x.p3.svg'] })
  // A Python run's table is not its whole result: only a SQL run's .csv is.
  expect(run?.data).toBeUndefined()
})

test('slugs are short kebab case', () => {
  expect(runSlug('Beta Params by_Panel!')).toBe('beta-params-by-panel')
  expect(runSlug('***')).toBe('query')
  expect(runSlug('a'.repeat(80))).toHaveLength(48)
})

test('CSV round-trips quotes, commas and newlines', () => {
  const rows = [
    ['a', 'b,c'],
    ['say "hi"', 'two\nlines'],
    ['', 'x'],
  ]
  const csv = toCsv(['h1', 'h2'], rows)
  expect(csv).toBe('h1,h2\na,"b,c"\n"say ""hi""","two\nlines"\n,x\n')
  expect(parsePsqlOutput(0, csv, '')).toEqual({ columns: ['h1', 'h2'], rows })
  expect(parsePsqlOutput(0, '', '')).toEqual({ columns: [], rows: [] })
  expect(parsePsqlOutput(1, '', 'psql:queries/001_x.sql:1: ERROR:  relation "x" does not exist\n')).toEqual({ error: 'ERROR:  relation "x" does not exist' })
})

test('the target comes from analysis.yaml, with defaults', () => {
  expect(readTarget('')).toEqual({ profile: 'Cint mkt', warehouse: '455a178462311474' })
  expect(readTarget('title: Churn\nprofile: DEFAULT\nwarehouse: abc # why\npg_database: panel\n')).toEqual({
    profile: 'DEFAULT',
    warehouse: 'abc',
    pgDatabase: 'panel',
  })
})

test('the CLI output gives columns and rows, or the error', () => {
  const ok = JSON.stringify([
    { sql: 'x', state: 'SUCCEEDED', columns: ['a'], rows: [['1'], ['2']] },
    { sql: 'SELECT 1', state: 'SUCCEEDED', columns: ['1'], rows: [['1']] },
  ])
  expect(parseCliOutput(ok, '')).toEqual({ columns: ['a'], rows: [['1'], ['2']] })

  const failed = JSON.stringify([
    { sql: 'x', state: 'FAILED', error: { message: '\n[PARSE_SYNTAX_ERROR] bad\n' } },
  ])
  expect(parseCliOutput(failed, '')).toEqual({ error: '[PARSE_SYNTAX_ERROR] bad' })
  expect(parseCliOutput('not json', 'Error: no profile')).toEqual({ error: 'Error: no profile' })
  expect(parseCliOutput('', '')).toEqual({ error: 'The Databricks CLI gave no output.' })
})

test('a SUCCEEDED statement with no result set is a success with no columns', () => {
  const select1 = { sql: 'SELECT 1', state: 'SUCCEEDED', columns: ['1'], rows: [['1']] }
  for (const sql of ['CREATE OR REPLACE TEMPORARY VIEW v AS SELECT 1 AS x', 'DROP VIEW v', "COMMENT ON TABLE t IS 'x'"]) {
    expect(parseCliOutput(JSON.stringify([{ sql, state: 'SUCCEEDED' }, select1]), '')).toEqual({ columns: [], rows: [] })
    expect(parseCliOutput(JSON.stringify([{ sql, state: 'SUCCEEDED', columns: [], rows: [] }, select1]), '')).toEqual({ columns: [], rows: [] })
  }
})

test('a FAILED, CANCELED or CLOSED statement is an error, with its message or else its state', () => {
  for (const state of ['FAILED', 'CANCELED', 'CLOSED']) {
    expect(parseCliOutput(JSON.stringify([{ sql: 'x', state, error: { message: 'boom' } }]), '')).toEqual({ error: 'boom' })
    expect(parseCliOutput(JSON.stringify([{ sql: 'x', state }]), '')).toEqual({ error: `Databricks reported the statement ${state}.` })
  }
})

test('venvCandidates walks from the folder up to the root, nearest first', () => {
  expect(venvCandidates('/work/notes-src/analyses/alpha')).toEqual([
    '/work/notes-src/analyses/alpha/.venv/bin/python',
    '/work/notes-src/analyses/.venv/bin/python',
    '/work/notes-src/.venv/bin/python',
    '/work/.venv/bin/python',
    '/.venv/bin/python',
  ])
  expect(venvCandidates('/')).toEqual(['/.venv/bin/python'])
  expect(venvCandidates('/a/b/')).toEqual(['/a/b/.venv/bin/python', '/a/.venv/bin/python', '/.venv/bin/python'])
})

test("the rules say Assay's venv is the only Python and that a missing package waits for the next release", () => {
  const rules = analysisRules('/venvs/0.4.3/bin/python', 'analyses/a')
  expect(rules).toContain("Assay's venv is the only Python for the tools")
  expect(rules).toContain('If a package is missing, add it to python/pyproject.toml in the Assay repo, lock it, and tell the user; the next Assay release builds it.')
  expect(rules).toContain('Never a Bash pip install and never another venv.')
  expect(rules).not.toContain('claude-pkg')
})

test('the rules are compact and carry the python path when known', () => {
  expect(analysisRules(undefined, 'analyses/a').length).toBeLessThan(2900)
  expect(analysisRules('/w/.venv/bin/python', 'analyses/a')).toContain('cd analyses/a && /w/.venv/bin/python -m pytest tests')
  expect(analysisRules(undefined, 'analyses/a')).toContain('python -m pytest tests')
})

test("the test line quotes a python whose path has a space, as Assay's venv does", () => {
  const python = '/Users/me/Library/Application Support/Assay/venvs/0.4.3/bin/python'
  expect(analysisRules(python, 'analyses/a')).toContain(`cd analyses/a && '${python}' -m pytest tests`)
  expect(analysisRules("/w/it's/bin/python", 'analyses/a')).toContain(`cd analyses/a && '/w/it'\\''s/bin/python' -m pytest tests`)
  for (const part of ['one concept', 'mcp__assay__park', 'mcp__assay__focus', 'mcp__assay__order', 'mcp__assay__python', 'q(N)', 'never through Bash', 'matplotlib', 'Altair', '.head()', 'lib/<name>.py', 'tests/test_<name>.py'])
    expect(analysisRules(undefined, 'analyses/a')).toContain(part)
  // Threads hold only rulings a person must make (specs/slices/slice-10.md).
  expect(analysisRules(undefined, 'analyses/a')).toContain('only for a ruling a person must make')
  expect(analysisRules(undefined, 'analyses/a')).not.toContain('park each other one')
})

test('a run result .json gives its status, or nothing when unreadable', () => {
  expect(statusOf('{"status":"ok","tables":[]}')).toBe('ok')
  expect(statusOf('{"status":"running"}')).toBe('running')
  for (const text of ['', '{nope', 'null', '{"status":3}', '[]']) expect(statusOf(text)).toBeUndefined()
})

test('kernel events are read a line at a time, and a partial line waits', () => {
  const ready = '{"event": "ready", "kernel": "k1", "pid": 42}\n'
  expect(splitKernelEvents(ready)).toEqual({ events: [{ event: 'ready', kernel: 'k1', pid: 42 }], rest: '' })
  expect(splitKernelEvents('{"event": "interr')).toEqual({ events: [], rest: '{"event": "interr' })
  expect(splitKernelEvents('{"event": "dead", "message": "gone"}\nnoise\n{"event": "stopped"}\n{"ev')).toEqual({
    events: [{ event: 'dead', message: 'gone' }, { event: 'stopped' }],
    rest: '{"ev',
  })
  expect(splitKernelEvents('{"event": "missing"}\n').events).toEqual([{ event: 'missing', message: 'The kernel is missing.' }])
  expect(splitKernelEvents('{"event": "ready"}\n{"event": "nope"}\n[1]\nnull\n').events).toEqual([])
})

test('the runner output is read, and a bad one says what it printed', () => {
  const out = { status: 'ok', stdout: 'hi', tables: [{ file: '014_x.t1.csv', columns: ['a'], rows: [[1], ['2']], rowCount: 12000, truncated: false }], plots: ['014_x.p1.png', { file: '014_x.p2.svg' }], reads: [12] }
  expect(parsePythonRun(`${JSON.stringify(out)}\n`)).toEqual({
    status: 'ok',
    stdout: 'hi',
    tables: [{ file: '014_x.t1.csv', columns: ['a'], rows: [['1'], ['2']], rowCount: 12000, truncated: false }],
    plots: ['014_x.p1.png', '014_x.p2.svg'],
    reads: [12],
  })
  expect(parsePythonRun('{"status":"error","error":{"name":"KeyError"}}')).toEqual({ status: 'error', stdout: '', error: { name: 'KeyError' }, tables: [], plots: [], reads: [] })
  expect(parsePythonRun('')).toEqual({ error: 'The kernel runner printed nothing.' })
  expect(parsePythonRun('Traceback boom')).toEqual({ error: 'The kernel runner printed: Traceback boom' })
  expect(parsePythonRun('{"status":"weird"}')).toEqual({ error: 'The kernel runner gave no status: {"status":"weird"}' })
})

test('a Python run reply: status and time, stdout, traceback tail, tables and plots', () => {
  const base: PythonRun = { status: 'ok', stdout: '', tables: [], plots: [], reads: [] }
  expect(formatPythonRun(14, base, 2300)).toBe('Run 014: ok (2.3 s).')
  expect(formatPythonRun(14, { ...base, stdout: 'hello\n' }, 100)).toBe('Run 014: ok (0.1 s).\nhello')
  const traceback = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1)}`).join('\n')
  const failed = formatPythonRun(15, { ...base, status: 'error', error: { name: 'KeyError', message: "'x'", traceback } }, 50).split('\n')
  expect(failed[0]).toBe('Run 015: error (0.1 s).')
  expect(failed).toHaveLength(31)
  expect(failed[1]).toBe('line 11')
  expect(failed.at(-1)).toBe('line 40')
  expect(formatPythonRun(15, { ...base, status: 'interrupted' }, 590000)).toBe('Run 015: interrupted (590.0 s).')
  const rows = Array.from({ length: 50 }, (_, i) => [String(i), 'x'])
  const full = formatPythonRun(16, { ...base, tables: [{ file: '016_t.t1.csv', columns: ['n', 'v'], rows, rowCount: 120, truncated: false }, { file: '016_t.t2.csv', columns: ['a'], rows: [['1']], rowCount: 1, truncated: false }], plots: ['016_t.p1.png'] }, 1000).split('\n')
  expect(full[1]).toBe('Table 1 (queries/016_t.t1.csv): 120 rows. Columns: n, v')
  expect(full[2]).toBe('n   v')
  expect(full[3]).toBe('0   x')
  expect(full[52]).toBe('49  x')
  expect(full[53]).toBe('Truncated: showing 50 of 120 rows. queries/016_t.t1.csv has all of them.')
  expect(full[54]).toBe('Table 2 (queries/016_t.t2.csv): 1 row. Columns: a')
  expect(full.at(-1)).toBe('Plot: queries/016_t.p1.png (Read it to check the chart.)')
})

test('Python header lines are written and stripped', () => {
  expect(pythonHeader({})).toBe('')
  expect(pythonHeader({ author: 'user' })).toBe('# author: user\n')
  expect(pythonHeader({ author: 'user', from: 12 })).toBe('# author: user\n# from: 012\n')
  expect(pythonHeader({ author: 'user', replay: 14 })).toBe('# author: user\n# replay: 014\n')
  expect(pythonBody('# author: user\n# from: 012\nx = 1\n# a comment\n')).toBe('x = 1\n# a comment\n')
  expect(pythonBody('# note\n# author: user\nx = 1\n')).toBe('# note\n# author: user\nx = 1\n')
})

test('requests are parsed by kind, and refused with a reason', () => {
  const json = (body: object) => parseRequestFile(JSON.stringify(body))
  expect(json({ kind: 'sql', sql: 'SELECT 1', from: 3, slug: 's' })).toEqual({ kind: 'sql', sql: 'SELECT 1', engine: 'databricks', from: 3, slug: 's' })
  expect(json({ kind: 'sql', sql: 'SELECT 1', engine: 'postgres' })).toEqual({ kind: 'sql', sql: 'SELECT 1', engine: 'postgres', slug: 'query' })
  expect(json({ kind: 'python', code: 'x', from: 12, slug: 'a' })).toEqual({ kind: 'python', code: 'x', from: 12, slug: 'a' })
  expect(json({ kind: 'python', code: 'x', from: 0 })).toEqual({ kind: 'python', code: 'x', slug: 'query' })
  expect(json({ kind: 'interrupt' })).toEqual({ kind: 'interrupt' })
  expect(json({ kind: 'restart' })).toEqual({ kind: 'restart' })
  expect(json({ kind: 'replay', runs: [12, 14] })).toEqual({ kind: 'replay', runs: [12, 14] })
  const refused = [
    ['{nope', 'The request is not valid JSON.'],
    ['[1]', 'Unknown request kind: undefined.'],
    ['null', 'The request is not a JSON object.'],
    [JSON.stringify({ kind: 'sql', sql: ' ' }), 'The SQL is empty.'],
    [JSON.stringify({ kind: 'sql', sql: 'x', engine: 'mysql' }), 'Unknown engine: mysql.'],
    [JSON.stringify({ kind: 'python', code: '' }), 'The code is empty.'],
    [JSON.stringify({ kind: 'replay', runs: [] }), 'Name the runs to replay, by number.'],
    [JSON.stringify({ kind: 'replay', runs: [1, 'x'] }), 'Name the runs to replay, by number.'],
    [JSON.stringify({ kind: 'bogus' }), 'Unknown request kind: bogus.'],
  ] as const
  for (const [text, error] of refused) expect(parseRequestFile(text)).toEqual({ error })
})

test('run headers are read from SQL and Python comments', () => {
  expect(parseRunHeader('-- author: user\n-- from: 012\n-- postgres\nSELECT 1\n')).toMatchObject({ author: 'user', from: 12, engine: 'postgres' })
  expect(parseRunHeader('# author: user\n# replay: 014\nx = 1\n', 'python')).toMatchObject({ author: 'user', replay: 14 })
  expect(parseRunHeader('SELECT 1\n-- author: user\n').author).toBe('claude')
  expect(parseRunHeader('# note\n# from: 003\nx\n', 'python')).toMatchObject({ author: 'claude', from: 3 })
  expect(parseRunHeader('').author).toBe('claude')
})

test('the run notice', () => {
  expect(runNotice([], 'analyses/a')).toBeUndefined()
  expect(runNotice([{ number: 14, language: 'python', from: 12 }, { number: 15, language: 'sql' }], 'analyses/a')).toBe(
    'Since your last turn the user ran: 014 python (from 012), 015 sql. Their Python ran in your kernel, so its variables may have changed; read analyses/a/queries/<file> when it matters.',
  )
  expect(runNotice([{ number: 15, language: 'sql' }], 'analyses/a')).toBe('Since your last turn the user ran: 015 sql. Read analyses/a/queries/<file> when it matters.')
  expect(runNotice([{ number: 16, language: 'python', replay: 14 }], 'analyses/a')).toContain('016 python (replay of 014)')
})

test('the run notice names no step check: those are data', () => {
  expect(analysisRules(undefined, 'analyses/a')).toContain("or step k of a SQL run's Steps with q(N, step=k)")
})

const REFUSED_COMMANDS = [
  'python x.py',
  'python3 analysis/x.py --flag',
  'python3.12 script.py',
  'ipython x.py',
  '/work/.venv/bin/python x.py',
  '.venv/bin/python3 x.py',
  'uv run python x.py',
  'uv run --with pandas python3 -c "print(1)"',
  'python -c "print(1)"',
  "python3 -c 'import os'",
  'python -u x.py',
  'python -',
  'python <<EOF\nprint(1)\nEOF',
  "python3 - <<'PY'\nimport os\nPY",
  'python < x.py',
  'cat x.py | python',
  'curl -s http://x | python3',
  'cd sub && python x.py',
  'ls; python x.py',
  'FOO=1 python x.py',
  'env FOO=1 python x.py',
  'time python x.py',
  'sudo -n python x.py',
  'bash -c "python x.py"',
  'python -W ignore x.py',
]

const ALLOWED_COMMANDS = [
  'python -m pytest tests',
  'python3 -m pytest -q',
  '/work/.venv/bin/python -m pytest tests',
  "cd analyses/a && '/Users/me/Library/Application Support/Assay/venvs/0.4.3/bin/python' -m pytest tests",
  'python -mpytest',
  'python -m pip install x',
  'python --version',
  'python3 -V',
  'pytest tests',
  'claude-pkg uv add pandas',
  'uv sync',
  'uv add pandas',
  'uv run pytest',
  'uv run python -m pytest',
  'ls -la',
  'grep python x.txt',
  'echo "python x.py"',
  'cat notes.md | grep python',
  'python',
  'curl x | python -m json.tool',
  'git commit -m "python x.py"',
  'cat <<EOF\npython x.py\nEOF',
  'pythonic x.py',
  'ls x.py',
]

test('the Bash guard refuses commands that run Python code, and lets pytest, pip and package commands through', () => {
  for (const command of REFUSED_COMMANDS) expect([command, bashRunsPython(command)]).toEqual([command, true])
  for (const command of ALLOWED_COMMANDS) expect([command, bashRunsPython(command)]).toEqual([command, false])
  expect(BASH_PYTHON_DENY).toBe('Run Python with mcp__assay__python: it runs in the kernel the user sees, and every run is saved. pytest and package commands stay allowed.')
})

test('the rules send findings to the note tools, cited and linked, and never to Write or Edit', () => {
  const rules = analysisRules(undefined, 'analyses/a')
  for (const part of ['mcp__assay__note', 'mcp__assay__revise_note', 'mcp__assay__link_notes', '[<slug> q N]', '[[ID]]', 'never Write or Edit under notes/']) expect(rules).toContain(part)
  for (const gone of ['new_note', 'notes.md', '[[slug]]']) expect(rules).not.toContain(gone)
  expect(rules.length).toBeLessThan(3200)
})

test('a table aligns columns and cuts wide cells', () => {
  const table = formatTable(['id', 'name'], [['1', 'alpha'], ['22', 'x'.repeat(30)]], 10)
  expect(table).toBe('id  name\n1   alpha\n22  xxxxxxxxx…')
})

test('trust requests are parsed by kind, and only the app sends them', () => {
  const json = (body: object) => parseRequestFile(JSON.stringify(body))
  expect(json({ kind: 'trust-list' })).toEqual({ kind: 'trust-list' })
  expect(json({ kind: 'trust-check', name: ' Main.Panel.Sites ' })).toEqual({ kind: 'trust-check', name: 'main.panel.sites' })
  expect(json({ kind: 'trust-done', name: 'f', outcome: 'approved' })).toEqual({ kind: 'trust-done', name: 'f', outcome: 'approved' })
  expect(json({ kind: 'trust-done', name: 'f', outcome: 'rejected' })).toEqual({ kind: 'trust-done', name: 'f', outcome: 'rejected' })
  expect(json({ kind: 'trust-check' })).toEqual({ error: 'Name the proposal.' })
  expect(json({ kind: 'trust-done', name: 'f', outcome: 'Trust' })).toEqual({ error: 'The outcome is approved, unchanged or rejected.' })
  expect(json({ kind: 'trust-answer', name: 'f', answer: 'trust' })).toEqual({ error: 'Unknown request kind: trust-answer.' })
  for (const kind of ['interrupt', 'restart', 'trust-list']) expect(isUrgent({ kind } as ServerRequest)).toBe(true)
  expect(isUrgent({ kind: 'trust-check', name: 'f' })).toBe(true)
  expect(isUrgent({ kind: 'sql', sql: 'x', engine: 'databricks', slug: 'q' })).toBe(false)
  expect(isUrgent({ kind: 'replay', runs: [1] })).toBe(false)
})

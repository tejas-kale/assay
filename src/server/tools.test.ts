// The analysis mod's tool tests (config b2f7df2, claude/analysis/tests/tools.test.ts), ported to the server.
// Registration, /an and the pane went with the mod; the rules on each prompt are the hook's (src/hooks).
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { answering, fake } from './testing.ts'

test('a session in an analysis sets up the files, leaving what exists', async () => {
  const ws = await fake()
  await ws.assay.setUp()
  expect(await ws.file('notes.md')).toBe('')
  expect(await ws.file('threads.md')).toBe('## Open\n\n## Closed\n')
  expect(await ws.file('notebook.md')).toBeUndefined()
  expect(await ws.file('lib/__init__.py')).toBe('')
  expect(await ws.file('.assay/.gitignore')).toBe('*\n')
  for (const dir of ['queries', 'lib', 'tests', 'notes']) expect(await ws.assay.exists(`${ws.analysis}/${dir}`)).toBe(true)
  await ws.done()
})

test('a folder without analysis.yaml is not set up, and every tool says to run the migration', async () => {
  const ws = await fake({})
  await ws.assay.setUp()
  expect(await ws.file('.analysis')).toBeUndefined()
  expect(await ws.file('analysis.yaml')).toBeUndefined()
  expect(await ws.file('notes.md')).toBeUndefined()
  for (const tool of ['sql', 'python', 'park', 'note']) expect(await ws.call(tool, { sql: 'SELECT 1', code: '1', thread: 'Q?', text: 'x' })).toMatch(/analyses\/feature has no analysis\.yaml.*migrate:root/s)
  expect(ws.runs).toEqual([])
  await ws.done()
})

test('existing files are left as they are', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'notes.md': 'kept\n', 'threads.md': '## Open\n1. Q?\n', 'notebook.md': 'mine\n', 'lib/__init__.py': 'x = 1\n' })
  await ws.assay.setUp()
  await ws.assay.relabel()
  expect(await ws.file('notes.md')).toBe('kept [unverified]\n')
  expect(await ws.file('threads.md')).toBe('## Open\n1. Q?\n')
  expect(await ws.file('notebook.md')).toBe('mine\n')
  expect(await ws.file('lib/__init__.py')).toBe('x = 1\n')
  await ws.done()
})

test('sql numbers after the highest query, saves both files and runs the CLI', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'queries/004_old.sql': 'SELECT 4\n' })
  ws.setRun(answering([['1', 'a,b']], ['id', 'name']))
  const reply = await ws.call('sql', { sql: 'SELECT id, name FROM t', slug: 'Ids and Names' })
  expect(await ws.file('queries/005_ids-and-names.sql')).toBe('SELECT id, name FROM t\n')
  expect(await ws.file('queries/005_ids-and-names.csv')).toBe('id,name\n1,"a,b"\n')
  expect(ws.runs.at(-1)).toEqual([
    'databricks', 'experimental', 'aitools', 'tools', 'query',
    '--profile', 'Cint mkt', '--warehouse', '455a178462311474',
    '--output', 'json', '--file', 'queries/005_ids-and-names.sql', 'SELECT 1',
  ])
  expect(reply).toBe('Query 005: 1 row. Columns: id, name\nid  name\n1   a,b')
  await ws.done()
})

test('sql uses the profile and warehouse analysis.yaml names', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\nprofile: DEFAULT\nwarehouse: abc123\n' })
  await ws.call('sql', { sql: 'SELECT 1', slug: 'one' })
  expect(ws.runs.at(-1)?.slice(5, 9)).toEqual(['--profile', 'DEFAULT', '--warehouse', 'abc123'])
  await ws.done()
})

test('sql with engine postgres runs rds-psql, marks the .sql and reads its CSV', async () => {
  const ws = await fake()
  ws.setRun(() => ({ stdout: 'id,name\n1,"a,b"\n' }))
  const reply = await ws.call('sql', { sql: 'SELECT id, name FROM t', slug: 'pg ids', engine: 'postgres' })
  expect(await ws.file('queries/001_pg-ids.sql')).toBe('-- postgres\nSELECT id, name FROM t\n')
  expect(await ws.file('queries/001_pg-ids.csv')).toBe('id,name\n1,"a,b"\n')
  expect(ws.runs.at(-1)).toEqual(['rds-psql', '-X', '--csv', '-v', 'ON_ERROR_STOP=1', '-f', 'queries/001_pg-ids.sql'])
  expect(reply).toBe('Query 001: 1 row. Columns: id, name\nid  name\n1   a,b')
  await ws.done()
})

test('sql reads the target from analysis.yaml: quotes, comments and other keys do not matter', async () => {
  const ws = await fake({ 'analysis.yaml': '# mine\ntitle: "Churn: Q3"\ncreated: 2026-11-02\nprofile: Cint mkt   # default\nwarehouse: \'w9\'\n' })
  await ws.call('sql', { sql: 'SELECT 1', slug: 'one' })
  expect(ws.runs.at(-1)?.slice(5, 9)).toEqual(['--profile', 'Cint mkt', '--warehouse', 'w9'])
  await ws.done()
})

test('sql with engine postgres uses the pg_database analysis.yaml names', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\npg_database: panel\n' })
  ws.setRun(() => ({ stdout: 'x\n' }))
  expect(await ws.call('sql', { sql: 'SELECT 1 AS x WHERE false', slug: 'none', engine: 'postgres' })).toBe('Query 001: 0 rows. Columns: x')
  expect(ws.runs.at(-1)?.slice(5)).toEqual(['-d', 'panel', '-f', 'queries/001_none.sql'])
  await ws.done()
})

test("a failed postgres query returns psql's error without its file prefix", async () => {
  const ws = await fake()
  ws.setRun(() => ({ exitCode: 3, stderr: 'psql:queries/001_bad.sql:2: ERROR:  relation "t" does not exist\nLINE 1: SELECT 1 FROM t\n' }))
  const reply = await ws.call('sql', { sql: 'SELECT 1 FROM t', slug: 'bad', engine: 'postgres' })
  expect(reply).toBe('Query 001 failed (saved analyses/feature/queries/001_bad.sql):\nERROR:  relation "t" does not exist\nLINE 1: SELECT 1 FROM t')
  expect(await ws.file('queries/001_bad.csv')).toBeUndefined()
  await ws.done()
})

test('sql returns at most 50 rows and says how many there are', async () => {
  const ws = await fake()
  ws.setRun(answering(Array.from({ length: 60 }, (_, i) => [String(i + 1)]), ['n']))
  const lines = (await ws.call('sql', { sql: 'SELECT n', slug: 'sixty' })).split('\n')
  expect(lines[0]).toBe('Query 001: 60 rows. Columns: n')
  expect(lines).toHaveLength(1 + 1 + 50 + 1)
  expect(lines[2]).toBe('1')
  expect(lines[51]).toBe('50')
  expect(lines.at(-1)).toBe('Truncated: showing 50 of 60 rows. The app and analyses/feature/queries/001_sixty.csv have all of them.')
  expect((await ws.file('queries/001_sixty.csv'))?.split('\n')).toHaveLength(62)
  await ws.done()
})

test('a result over 4 MiB is refused, not saved', async () => {
  const ws = await fake()
  ws.setRun(() => ({ stdout: '[', isStdoutTruncated: true }))
  expect(await ws.call('sql', { sql: 'SELECT *', slug: 'big' })).toBe('Query 001 failed (saved analyses/feature/queries/001_big.sql):\nThe result is over 4 MiB. Aggregate it or add a LIMIT.')
  await ws.done()
})

test('a failed query keeps its .sql, writes no .csv and returns the error; runs.json records it', async () => {
  const ws = await fake()
  ws.setRun(() => ({ exitCode: 1, stdout: JSON.stringify([{ state: 'FAILED', error: { message: '\n[PARSE_SYNTAX_ERROR] near SELEC\n' } }]) }))
  expect(await ws.call('sql', { sql: 'SELEC 1', slug: 'bad' })).toBe('Query 001 failed (saved analyses/feature/queries/001_bad.sql):\n[PARSE_SYNTAX_ERROR] near SELEC')
  expect(await ws.file('queries/001_bad.sql')).toBe('SELEC 1\n')
  expect(await ws.file('queries/001_bad.csv')).toBeUndefined()
  expect(await ws.status()).toEqual({ running: null, failed: { '1': '[PARSE_SYNTAX_ERROR] near SELEC' } })
  ws.setRun(answering([], ['x']))
  expect(await ws.call('sql', { sql: 'SELECT 1', slug: 'bad' })).toBe('Query 002: 0 rows. Columns: x')
  await ws.done()
})

test('a CLI that cannot start is an error, not a crash', async () => {
  const ws = await fake()
  ws.setRun(() => ({ exitCode: 1, stderr: 'Error: cannot configure default credentials' }))
  expect(await ws.call('sql', { sql: 'SELECT 1', slug: 'x' })).toMatch(/^Query 001 failed .*\nError: cannot configure default credentials$/)
  expect(await ws.call('sql', { sql: '  ', slug: 'x' })).toBe('Give the SQL to run.')
  await ws.done()
})

test('runs.json names the running query before its file exists', async () => {
  const ws = await fake()
  let seen: unknown
  ws.setRun(async () => {
    seen = await ws.status()
    return answering([], ['x'])([])
  })
  await ws.call('sql', { sql: 'SELECT 1', slug: 'a' })
  expect(seen).toMatchObject({ running: { number: 1 }, failed: {} })
  expect(await ws.status()).toEqual({ running: null, failed: {} })
  await ws.done()
})

test('park and close round-trip through threads.md', async () => {
  const ws = await fake()
  await ws.assay.setUp()
  expect(await ws.call('park', { thread: 'Why is alpha 0?' })).toBe('Parked. 1 open thread.')
  await ws.call('park', { thread: 'Is rate per survey?' })
  expect(await ws.file('threads.md')).toBe('## Open\n1. Why is alpha 0?\n2. Is rate per survey?\n\n## Closed\n')
  expect(await ws.call('close', { thread: '1', outcome: 'test panels' })).toBe('Closed "Why is alpha 0?". Next open thread: 1. Is rate per survey?')
  expect(await ws.file('threads.md')).toBe('## Open\n1. Is rate per survey?\n\n## Closed\n- Why is alpha 0? → test panels\n')
  expect(await ws.call('close', { thread: 'per survey' })).toBe('Closed "Is rate per survey?". No open threads left.')
  expect(await ws.call('close', { thread: 'nope' })).toBe('No open thread matches "nope".')
  expect(await ws.call('park', { thread: '  ' })).toBe('Give the thread as one line.')
  await ws.done()
})

test('focus moves an open thread to the top', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'threads.md': '## Open\n1. A?\n2. B?\n3. C?\n\n## Closed\n' })
  expect(await ws.call('focus', { thread: '3' })).toBe('Focused: 1. C?')
  expect(await ws.file('threads.md')).toBe('## Open\n1. C?\n2. A?\n3. B?\n\n## Closed\n')
  expect(await ws.call('focus', { thread: 'nope' })).toBe('No open thread matches "nope".')
  await ws.done()
})

test('order rearranges the open threads and returns the new list', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'threads.md': '## Open\n1. A?\n2. B?\n3. C?\n\n## Closed\n- Z? → no\n' })
  expect(await ws.call('order', { threads: ['3', 'A?'] })).toBe('Open threads now:\n1. C?\n2. A?\n3. B?')
  expect(await ws.file('threads.md')).toBe('## Open\n1. C?\n2. A?\n3. B?\n\n## Closed\n- Z? → no\n')
  expect(await ws.call('order', { threads: [] })).toBe('Give the threads to move to the top, in order.')
  expect(await ws.call('order', { threads: ['nope'] })).toBe('No open thread matches "nope".')
  await ws.done()
})

test('note appends one line, with the query that verified it', async () => {
  const ws = await fake()
  await ws.assay.setUp()
  expect(await ws.call('note', { text: 'beta is per panel', query: 7 })).toBe('Noted as unverified q 007. Query 007 has no result (.csv).')
  await ws.call('note', { text: 'is_test excludes staff' })
  expect(await ws.file('notes.md')).toBe('beta is per panel [unverified q 007]\nis_test excludes staff [unverified]\n')
  await ws.done()
})

test('note labels a Python run computed when its .json says ok, unverified otherwise', async () => {
  const ws = await fake({
    'analysis.yaml': 'title: Feature\n',
    'queries/001_a.py': 'print(1)\n',
    'queries/001_a.json': '{"status":"ok"}',
    'queries/002_b.py': 'raise KeyError\n',
    'queries/002_b.json': '{"status":"error"}',
    'queries/003_c.py': 'x\n',
  })
  const note = (text: string, query: number) => ws.call('note', { text, query })
  expect(await note('mean is 3', 1)).toBe('Noted as computed q 001.')
  expect(await note('broke', 2)).toBe('Noted as unverified q 002. Run 002 did not finish ok (error).')
  expect(await note('no result', 3)).toBe('Noted as unverified q 003. Run 003 did not finish ok (no result).')
  expect(await ws.file('notes.md')).toBe('mean is 3 [computed q 001]\nbroke [unverified q 002]\nno result [unverified q 003]\n')
  expect(await ws.call('revise_note', { note: 'broke', query: 1 })).toBe('Note 2 is now computed q 001.')
  await ws.done()
})

test('note labels from the query: queried with its .csv, unverified without; a label Claude writes is dropped', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'queries/001_a.sql': 'SELECT 1\n', 'queries/001_a.csv': 'x\n1\n', 'queries/002_b.sql': 'SELECT nope\n' })
  const note = (text: string, query?: number) => ws.call('note', { text, ...(query ? { query } : {}) })
  expect(await note('one row', 1)).toBe('Noted as queried q 001.')
  expect(await note('failed', 2)).toBe('Noted as unverified q 002. Query 002 has no result (.csv).')
  expect(await note('no such query', 9)).toBe('Noted as unverified q 009. Query 009 has no result (.csv).')
  expect(await note('claims trust [trusted q 001]', 2)).toBe('Noted as unverified q 002. Query 002 has no result (.csv).')
  expect(await ws.file('notes.md')).toBe('one row [queried q 001]\nfailed [unverified q 002]\nno such query [unverified q 009]\nclaims trust [unverified q 002]\n')
  await ws.done()
})

test('a note citing a trusted run with its result is trusted', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'queries/001_t.sql': '-- trusted: f\n-- args: {}\n-- commit: abc\nSELECT 1\n', 'queries/001_t.csv': 'x\n1\n' })
  expect(await ws.call('note', { text: 'f is 1', query: 1 })).toBe('Noted as trusted q 001.')
  await ws.done()
})

test('notes from before labels are labelled on activation; labelled ones and note files are kept', async () => {
  const ws = await fake({
    'analysis.yaml': 'title: Feature\n',
    'notes.md': 'has result [q 001]\nfailed [q 002]\nno query\nkept [unverified]\n[A note](</n/a.md>)\ntrusted run [q 003]\n',
    'queries/001_a.sql': 'SELECT 1\n',
    'queries/001_a.csv': 'x\n1\n',
    'queries/002_b.sql': 'SELECT nope\n',
    'queries/003_t.sql': '-- trusted: f\n-- args: {}\n-- commit: abc\nSELECT 1\n',
    'queries/003_t.csv': 'x\n1\n',
  })
  expect(await ws.assay.relabel()).toBe(4)
  expect(await ws.file('notes.md')).toBe(
    'has result [queried q 001]\nfailed [unverified q 002]\nno query [unverified]\nkept [unverified]\n[A note](</n/a.md>)\ntrusted run [queried q 003]\n',
  )
  await ws.done()
})

test('an old note citing an ok Python run is relabelled computed, not unverified', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'notes.md': 'rate is 4 [q 1]\nrate is 5 [q 2]\n', 'queries/001_x.py': 'print(4)\n', 'queries/001_x.json': JSON.stringify({ status: 'ok' }), 'queries/002_y.py': '1/0\n', 'queries/002_y.json': JSON.stringify({ status: 'error' }) })
  await ws.assay.relabel()
  expect(await ws.file('notes.md')).toBe('rate is 4 [computed q 001]\nrate is 5 [unverified q 002]\n')
  await ws.done()
})

test('revise_note cites a new query, or deletes, by line number or text', async () => {
  const ws = await fake({
    'analysis.yaml': 'title: Feature\n',
    'notes.md': 'alpha is 0 [unverified]\n[A note](</n/a.md>)\nbeta per panel [unverified]\n',
    'queries/003_c.sql': 'SELECT 3\n',
    'queries/003_c.csv': 'x\n3\n',
  })
  const revise = (input: Record<string, unknown>) => ws.call('revise_note', input)
  expect(await revise({ note: '1', query: 3 })).toBe('Note 1 is now queried q 003.')
  expect(await revise({ note: '2', query: 3 })).toBe('No note 2 in notes.md.')
  expect(await revise({ note: 'beta' })).toBe('Give the query that verifies it, or delete: true.')
  expect(await revise({ note: 'beta per panel', delete: true })).toBe('Deleted note 3: beta per panel')
  expect(await revise({ note: 'gamma', delete: true })).toBe('No note matches "gamma".')
  expect(await ws.file('notes.md')).toBe('alpha is 0 [queried q 003]\n[A note](</n/a.md>)\n')
  await ws.done()
})

test('link_note lists the file Claude wrote, by the title at its top, once', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'notes.md': 'beta is per panel [unverified q 001]\n', '/repos/llm-wiki/panels/alpha.md': '# Alpha is 0 for test panels\n\nBody.\n' })
  const path = `${ws.dir}/repos/llm-wiki/panels/alpha.md`
  expect(await ws.call('link_note', { path })).toBe(`Listed "Alpha is 0 for test panels" in analyses/feature/notes.md; the app's Notes tab shows it.`)
  expect(await ws.file('notes.md')).toBe(`beta is per panel [unverified q 001]\n[Alpha is 0 for test panels](<${path}>)\n`)
  expect(await ws.call('link_note', { path })).toMatch(/already listed/)
  expect(await ws.call('link_note', { path: `${ws.dir}/repos/llm-wiki/missing.md` })).toBe(`Cannot read ${ws.dir}/repos/llm-wiki/missing.md. Write the note there first.`)
  expect(await ws.call('link_note', { path: '~/wiki/a.md' })).toBe('Give the note file as an absolute path.')
  expect(await ws.file('/repos/llm-wiki/panels/alpha.md')).toBe('# Alpha is 0 for test panels\n\nBody.\n')
  await ws.done()
})

test('link_note takes a relative path from the root or the analysis, and refuses one that exists in both', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'both.md': '# In analysis\n', 'mine.md': '# Mine\n', '/work/both.md': '# In root\n', '/work/shared.md': '# Shared\n' })
  expect(await ws.call('link_note', { path: 'both.md' })).toBe(`both.md exists under the root (${ws.root}/both.md) and in the analysis (${ws.analysis}/both.md). Give an absolute path.`)
  expect(await ws.call('link_note', { path: 'mine.md' })).toMatch(/^Listed "Mine"/)
  expect(await ws.call('link_note', { path: 'shared.md' })).toMatch(/^Listed "Shared"/)
  await ws.done()
})

test('new_note numbers the note, writes its title and text, and says what does not resolve', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'queries/002_x.sql': 'SELECT 1' })
  await ws.assay.setUp()
  const make = (title: string, slug: string, body: string) => ws.call('new_note', { title, slug, text: body })
  expect(await make('First look', 'first-look', 'The panel has 5 sites [q 2].\n')).toBe('Wrote analyses/feature/notes/001-first-look.md. Link it from other notes with [[first-look]].')
  expect(await ws.file('notes/001-first-look.md')).toBe('# First look\n\nThe panel has 5 sites [q 2].\n')
  await ws.put('notes/007-old.md', '# Old\n')
  expect(await make('Second', 'second', '  See [[first-look]], [[007-old]], [[nope]], [[second]] and [[later]]. Runs [q 2], [q 99], [q 120].  ')).toBe(
    ['Wrote analyses/feature/notes/008-second.md. Link it from other notes with [[second]].', 'Unknown runs: 099, 120.', 'Unresolved links: [[nope]], [[later]].'].join('\n'),
  )
  expect(await ws.file('notes/008-second.md')).toBe('# Second\n\nSee [[first-look]], [[007-old]], [[nope]], [[second]] and [[later]]. Runs [q 2], [q 99], [q 120].\n')
  expect(await make('Again', 'first-look', 'x')).toBe('A note first-look exists: analyses/feature/notes/001-first-look.md. Edit it with Edit.')
  expect(await ws.file('notes/009-first-look.md')).toBeUndefined()
  expect(await make('Bad', 'Not A Slug', 'x')).toBe('The slug is lower case letters, digits and -, starting with a letter or digit.')
  expect(await make('  ', 'ok', 'x')).toBe('Give the note a title.')
  // Notes are not listed in notes.md.
  expect(await ws.file('notes.md')).toBe('')
  await ws.done()
})

test('new_note called twice at once claims two numbers', async () => {
  const ws = await fake()
  const make = (slug: string) => ws.call('new_note', { title: slug, slug, text: 'x' })
  await Promise.all([make('a'), make('b')])
  expect(await ws.list('notes')).toEqual(['notes/001-a.md', 'notes/002-b.md'])
  await ws.done()
})

test('two runs at once claim two numbers', async () => {
  const ws = await fake()
  await Promise.all([ws.call('sql', { sql: 'SELECT 1', slug: 'a' }), ws.call('sql', { sql: 'SELECT 2', slug: 'b' })])
  expect((await ws.list('queries')).filter(name => name.endsWith('.sql'))).toEqual(['queries/001_a.sql', 'queries/002_b.sql'])
  await ws.done()
})

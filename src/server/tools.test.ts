// The analysis mod's tool tests (config b2f7df2, claude/analysis/tests/tools.test.ts), ported to the server.
// Registration, /an and the pane went with the mod; the rules on each prompt are the hook's (src/hooks).
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { answering, fake } from './testing.ts'

test('a session in an analysis sets up the files, leaving what exists', async () => {
  const ws = await fake()
  await ws.assay.setUp()
  expect(await ws.file('notes.md')).toBeUndefined()
  expect(await ws.file('threads.md')).toBe('## Open\n\n## Closed\n')
  expect(await ws.file('notebook.md')).toBeUndefined()
  expect(await ws.file('lib/__init__.py')).toBe('')
  expect(await ws.file('.assay/.gitignore')).toBe('*\n')
  for (const dir of ['queries', 'lib', 'tests']) expect(await ws.assay.exists(`${ws.analysis}/${dir}`)).toBe(true)
  expect(await ws.assay.exists(`${ws.analysis}/notes`)).toBe(false)
  await ws.done()
})

test('a folder without analysis.yaml is not set up, and every tool says to run the migration', async () => {
  const ws = await fake({})
  await ws.assay.setUp()
  expect(await ws.file('.analysis')).toBeUndefined()
  expect(await ws.file('analysis.yaml')).toBeUndefined()
  expect(await ws.file('notes.md')).toBeUndefined()
  for (const tool of ['sql', 'python', 'park', 'note']) expect(await ws.call(tool, { sql: 'SELECT 1', code: '1', thread: 'Q?', title: 'x', text: 'x' })).toMatch(/analyses\/feature has no analysis\.yaml.*migrate:root/s)
  expect(ws.runs).toEqual([])
  await ws.done()
})

test('existing files are left as they are', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'threads.md': '## Open\n1. Q?\n', 'notebook.md': 'mine\n', 'lib/__init__.py': 'x = 1\n' })
  await ws.assay.setUp()
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

test('a postgres run where rds-psql is not on PATH fails with the launch contract', async () => {
  const ws = await fake()
  // What spawn says for a program it cannot find.
  ws.setRun(() => ({ exitCode: 127, stderr: 'spawn rds-psql ENOENT' }))
  const reply = await ws.call('sql', { sql: 'SELECT 1', slug: 'pg', engine: 'postgres' })
  expect(reply).toBe('Query 001 failed (saved analyses/feature/queries/001_pg.sql):\nPostgres runs need a launcher that provides rds-psql (docs/process/launch-contract.md).')
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

test('a statement with no result set succeeds: an empty .csv, an ok reply, no failure in runs.json', async () => {
  const ws = await fake()
  const sql = 'CREATE OR REPLACE TEMPORARY VIEW status_probe_view AS SELECT 1 AS x'
  ws.setRun(() => ({
    stdout: JSON.stringify([
      { sql, state: 'SUCCEEDED' },
      { sql: 'SELECT 1', state: 'SUCCEEDED', columns: ['1'], rows: [['1']] },
    ]),
  }))
  expect(await ws.call('sql', { sql, slug: 'probe view' })).toBe('Query 001: ok, no result set.')
  expect(await ws.file('queries/001_probe-view.sql')).toBe(`${sql}\n`)
  expect(await ws.file('queries/001_probe-view.csv')).toBe('')
  expect(await ws.status()).toEqual({ running: null, failed: {} })
  await ws.done()
})

test('a CTAS keeps its result set: its counts are the rows', async () => {
  const ws = await fake()
  ws.setRun(answering([['0', '0']], ['num_affected_rows', 'num_inserted_rows']))
  expect(await ws.call('sql', { sql: 'CREATE OR REPLACE TABLE x AS SELECT 1 AS a', slug: 'ctas' })).toBe('Query 001: 1 row. Columns: num_affected_rows, num_inserted_rows\nnum_affected_rows  num_inserted_rows\n0                  0')
  expect(await ws.file('queries/001_ctas.csv')).toBe('num_affected_rows,num_inserted_rows\n0,0\n')
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

const NOTES_AT = '/work/notes'
const yamlLists = (written: string[], found: string[]) => `title: Feature\nnotes:\n  written: [${written.join(', ')}]\n  found: [${found.join(', ')}]\n`
const noteFiles = async (ws: Awaited<ReturnType<typeof fake>>) => (await readdir(join(ws.root, 'notes')).catch(() => [])).sort()

test('note writes a root note, qualifies bare citations and lists it under written', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'queries/001_a.sql': 'SELECT 1\n', 'queries/001_a.csv': 'x\n1\n' })
  const reply = await ws.call('note', { title: 'Beta is per panel', text: 'It is 1 [q 1] and [q 001].' })
  const [file] = await noteFiles(ws)
  const id = /^(\d{8}T\d{6})-beta-is-per-panel\.md$/.exec(file ?? '')?.[1] ?? ''
  expect(id === '').toBe(false)
  expect(reply).toBe(`Wrote notes/${file}. Link it with [[${id}]].`)
  expect(await ws.file(`${NOTES_AT}/${file}`)).toBe('# Beta is per panel\n\nIt is 1 [feature q 1] and [feature q 1].\n')
  expect(await ws.file('analysis.yaml')).toBe(`title: Feature\nnotes:\n  written: [${id}]\n  found: []\n`)
  // Nothing is created in the analysis folder for notes.
  expect(await ws.file('notes.md')).toBeUndefined()
  await ws.done()
})

test('note says what does not resolve, and still writes', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'queries/001_a.sql': 'SELECT 1\n' })
  await ws.put('/work/analyses/other/queries/002_b.sql', 'SELECT 2\n')
  await ws.put(`${NOTES_AT}/20260101T000000-old.md`, '# Old\n')
  const reply = await ws.call('note', { title: 'Second', text: 'See [[20260101T000000]], [[20250101T000000]]. Runs [q 1], [q 99], [other q 2], [other q 3], [gone q 1].' })
  const lines = reply.split('\n')
  expect(lines[0]).toMatch(/^Wrote notes\/\d{8}T\d{6}-second\.md\. Link it with \[\[\d{8}T\d{6}\]\]\.$/)
  expect(lines.slice(1)).toEqual(['Unknown runs: feature q 099, other q 003, gone q 001.', 'Unresolved links: [[20250101T000000]].'])
  expect((await noteFiles(ws)).length).toBe(2)
  await ws.done()
})

test('note twice in one second bumps the second ID; an empty title is refused', async () => {
  const ws = await fake()
  await Promise.all([ws.call('note', { title: 'a', text: 'x' }), ws.call('note', { title: 'b', text: 'x' })])
  const files = await noteFiles(ws)
  expect(files.length).toBe(2)
  expect(new Set(files.map(file => file.slice(0, 15))).size).toBe(2)
  expect(await ws.call('note', { title: '  ', text: 'x' })).toBe('Give the note a title.')
  await ws.done()
})

test('revise_note replaces exact text once, and refuses a missing or ambiguous old', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n' })
  await ws.put(`${NOTES_AT}/20260101T000000-alpha.md`, '# Alpha\n\nA is 1. B is 2. B is 2.\n')
  const revise = (input: Record<string, unknown>) => ws.call('revise_note', { id: '20260101T000000', ...input })
  expect(await revise({ old: 'A is 1', new: 'A is 5 [q 3]' })).toMatch(/^Revised notes\/20260101T000000-alpha\.md\.\nUnknown runs: feature q 003\.$/)
  expect(await ws.file(`${NOTES_AT}/20260101T000000-alpha.md`)).toBe('# Alpha\n\nA is 5 [feature q 3]. B is 2. B is 2.\n')
  expect(await revise({ old: 'C is 3', new: 'x' })).toMatch(/not in the note.*Read the note again/)
  expect(await revise({ old: 'B is 2', new: 'x' })).toMatch(/more than once/)
  expect(await revise({ title: 'Alpha five' })).toBe('Revised notes/20260101T000000-alpha.md.\nUnknown runs: feature q 003.')
  expect(await ws.file(`${NOTES_AT}/20260101T000000-alpha.md`)).toMatch(/^# Alpha five\n\nA is 5/)
  expect(await revise({})).toBe('Give old and new, or title, or delete: true.')
  expect(await ws.call('revise_note', { id: '20990101T000000', title: 'x' })).toBe('No note 20990101T000000 in notes/.')
  await ws.done()
})

test('revise_note deletes only a note this analysis wrote', async () => {
  const ws = await fake({ 'analysis.yaml': yamlLists(['20260101T000000'], ['20260202T000000']) })
  await ws.put(`${NOTES_AT}/20260101T000000-mine.md`, '# Mine\n')
  await ws.put(`${NOTES_AT}/20260202T000000-theirs.md`, '# Theirs\n')
  expect(await ws.call('revise_note', { id: '20260202T000000', delete: true })).toMatch(/not written by this analysis/)
  expect(await ws.call('revise_note', { id: '20260101T000000', delete: true })).toBe('Deleted notes/20260101T000000-mine.md.')
  expect(await noteFiles(ws)).toEqual(['20260202T000000-theirs.md'])
  expect(await ws.file('analysis.yaml')).toBe(yamlLists([], ['20260202T000000']))
  await ws.done()
})

test('link_notes lists found notes, ignores its own, and refuses unknown IDs', async () => {
  const ws = await fake({ 'analysis.yaml': yamlLists(['20260101T000000'], []) })
  await ws.put(`${NOTES_AT}/20260101T000000-mine.md`, '# Mine\n')
  await ws.put(`${NOTES_AT}/20260202T000000-theirs.md`, '# Theirs\n')
  expect(await ws.call('link_notes', { ids: ['20260202T000000', '20990101T000000'] })).toBe('Unknown notes: 20990101T000000. Nothing was linked; use the IDs in the file names in notes/.')
  expect(await ws.file('analysis.yaml')).toBe(yamlLists(['20260101T000000'], []))
  expect(await ws.call('link_notes', { ids: ['20260202T000000', '20260101T000000'] })).toBe('Linked 20260202T000000 Theirs. Skipped 1 written by this analysis.')
  expect(await ws.file('analysis.yaml')).toBe(yamlLists(['20260101T000000'], ['20260202T000000']))
  expect(await ws.call('link_notes', { ids: [] })).toBe('Give the IDs of the notes to link.')
  await ws.done()
})

// note_labels: the label of each citation in the notes this analysis wrote.
const CALC = '-- trusted: completes\n-- args: {}\n-- commit: abc123\nselect 3'
const labelFiles = (written: string[] = ['20260101T000000', '20260102T000000']) => ({
  'analysis.yaml': yamlLists(written, []),
  'queries/001_plain.sql': 'select 1',
  'queries/001_plain.csv': 'a\n1\n',
  'queries/002_nodata.sql': 'select 2',
  'queries/003_calc.sql': CALC,
  'queries/003_calc.csv': 'a\n1\n',
  'queries/004_py.py': 'print(1)',
  'queries/004_py.json': '{"status":"ok","stdout":""}',
})
const putNotes = async (ws: Awaited<ReturnType<typeof fake>>) => {
  await ws.put(`${NOTES_AT}/20260101T000000-solid.md`, '# Solid\n\nOne [feature q 1], three [feature q 3], python [feature q 4].\n')
  await ws.put(`${NOTES_AT}/20260102T000000-shaky.md`, '# Shaky\n\nNo data [feature q 2], gone [feature q 9], [other q 1].\n')
}

test('note_labels lists each citation of the written notes with its label, weak notes and weak labels first', async () => {
  const ws = await fake(labelFiles(), { currentCommit: async () => 'abc123' })
  await putNotes(ws)
  expect(await ws.call('note_labels')).toBe(
    ['20260102T000000 Shaky', '[feature q 2] unverified', '[feature q 9] missing', '[other q 1] missing', '', '20260101T000000 Solid', '[feature q 1] queried', '[feature q 3] trusted', '[feature q 4] computed'].join('\n'),
  )
  await ws.done()
})

test('note_labels with weak: true lists only notes with a weak citation, and one id may be any root note', async () => {
  const ws = await fake(labelFiles(['20260101T000000']), { currentCommit: async () => 'abc123' })
  await putNotes(ws)
  expect(await ws.call('note_labels', { weak: true })).toBe('No weak citations in the notes this analysis wrote.')
  expect(await ws.call('note_labels', { id: '20260102T000000', weak: true })).toBe(['20260102T000000 Shaky', '[feature q 2] unverified', '[feature q 9] missing', '[other q 1] missing'].join('\n'))
  expect(await ws.call('note_labels', { id: '20260101T000000', weak: true })).toBe('20260101T000000 Solid has no weak citation.')
  expect(await ws.call('note_labels', { id: '20990101T000000' })).toBe('No note 20990101T000000 in notes/.')
  await ws.done()
  const none = await fake()
  expect(await none.call('note_labels')).toBe('This analysis has written no notes.')
  await none.done()
})

test('note_labels flags a written ID with no note file instead of failing the whole reply', async () => {
  const ws = await fake(labelFiles(['20260101T000000', '20260103T000000']), { currentCommit: async () => 'abc123' })
  await putNotes(ws)
  expect(await ws.call('note_labels')).toBe(
    ['20260103T000000 no file in notes/', '', '20260101T000000 Solid', '[feature q 1] queried', '[feature q 3] trusted', '[feature q 4] computed'].join('\n'),
  )
  expect(await ws.call('note_labels', { weak: true })).toBe('20260103T000000 no file in notes/')
  await ws.done()
})

test('note_labels does not call stale unchecked for a dictionary definition run', async () => {
  const ws = await fake({ ...labelFiles(['20260104T000000']), 'queries/005_def.sql': '-- trusted: main.panel.surveys:active\n-- args: {}\n-- commit: abc123\nselect 5', 'queries/005_def.csv': 'a\n1\n' })
  await ws.put(`${NOTES_AT}/20260104T000000-def.md`, '# Def\n\nActive [feature q 5].\n')
  expect(await ws.call('note_labels')).toBe(['20260104T000000 Def', '[feature q 5] trusted'].join('\n'))
  await ws.done()
})

test('note_labels shows stale when the calculation moved, and says when stale was not checked', async () => {
  const moved = await fake(labelFiles(), { currentCommit: async () => 'def456' })
  await putNotes(moved)
  expect(await moved.call('note_labels', { weak: true })).toMatch(/^20260101T000000 Solid\n\[feature q 3\] stale\n/)
  expect(await moved.call('note_labels')).not.toContain('Stale was not checked')
  await moved.done()
  for (const options of [{}, { currentCommit: async () => undefined }]) {
    const ws = await fake(labelFiles(), options)
    await putNotes(ws)
    const reply = await ws.call('note_labels')
    expect(reply).toContain('[feature q 3] trusted')
    expect(reply.split('\n').at(-1)).toBe('Stale was not checked: the current commit of completes could not be found.')
    await ws.done()
  }
})

test('the first run of an analysis with no notes ends with the search line, once', async () => {
  const ws = await fake()
  ws.assay.searchHinted = false
  const first = await ws.call('sql', { sql: 'SELECT 1', slug: 'a' })
  expect(first.split('\n').at(-1)).toMatch(/^This analysis has no notes yet\. Search notes\/ .*call link_notes/)
  expect(await ws.call('sql', { sql: 'SELECT 1', slug: 'b' })).not.toMatch(/Search notes/)
  await ws.done()
})

test('no search line when the analysis already has notes, or when no run happened', async () => {
  const ws = await fake({ 'analysis.yaml': yamlLists([], ['20260202T000000']) })
  ws.assay.searchHinted = false
  expect(await ws.call('sql', { sql: 'SELECT 1', slug: 'a' })).not.toMatch(/Search notes/)
  await ws.done()
  const bare = await fake()
  bare.assay.searchHinted = false
  expect(await bare.call('sql', { sql: '  ', slug: 'a' })).toBe('Give the SQL to run.')
  expect(await bare.call('sql', { sql: 'SELECT 1', slug: 'a' })).toMatch(/Search notes/)
  await bare.done()
})

test('two runs at once claim two numbers', async () => {
  const ws = await fake()
  await Promise.all([ws.call('sql', { sql: 'SELECT 1', slug: 'a' }), ws.call('sql', { sql: 'SELECT 2', slug: 'b' })])
  expect((await ws.list('queries')).filter(name => name.endsWith('.sql'))).toEqual(['queries/001_a.sql', 'queries/002_b.sql'])
  await ws.done()
})

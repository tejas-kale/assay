// The SQL rules on Claude's `sql` calls (docs/slice-9.md, slice 9a): `python -m analysis_sql lint` runs first on a
// statement with WITH or JOIN; a rejection runs nothing, a warning reaches the reply, a lint that cannot run does not block.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { VENV_MISSING } from '../core/venv.ts'
import { runSql } from './sqlRun.ts'
import type { SqlLint } from './sqlRun.ts'
import type { RunOptions, RunResult } from './proc.ts'
import { answering, fake } from './testing.ts'
import type { Fake } from './testing.ts'

const FILES = { 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay/bin/python': '' }
const CTE_SQL = 'WITH ow AS (SELECT 1 AS x) SELECT x FROM ow'

/** The lint answers `lint` (or exits as `lint` says); every other run is the query, answering one row. */
function scripted(ws: Fake, lint: Partial<RunResult> | SqlLint, seen: { input?: string; argv?: readonly string[] } = {}) {
  ws.setRun((argv, options?: RunOptions) => {
    // The retype check (docs/slice-10.md) finds nothing here; include.test.ts and retype.test.ts cover it.
    if (argv[3] === 'analysis_sql' && argv[4] === 'retype') return { stdout: '{"warnings": []}' }
    if (argv[3] === 'analysis_sql') {
      seen.argv = argv
      if (options?.input !== undefined) seen.input = options.input
      return 'errors' in lint ? { stdout: JSON.stringify(lint) } : lint
    }
    return answering([['1']], ['x'])(argv)
  })
}

const lintRuns = (ws: Fake) => ws.runs.filter(argv => argv[3] === 'analysis_sql' && argv[4] === 'lint')

test('a statement that breaks the rules is not run: no number claimed, no file, the reply lists each problem', async () => {
  const ws = await fake(FILES)
  const seen: { input?: string; argv?: readonly string[] } = {}
  scripted(ws, { errors: ['CTE ow: no "-- grain:" line above it.', 'CTE ow: name too short; say what it holds.'], warnings: [] }, seen)
  const reply = await ws.call('sql', { sql: CTE_SQL, slug: 'ow', engine: 'postgres' })
  expect(reply).toBe('Not run: the query breaks the SQL rules. Fix and send again:\n- CTE ow: no "-- grain:" line above it.\n- CTE ow: name too short; say what it holds.')
  expect(seen.argv).toEqual([`${ws.venv}/bin/python`, '-I', '-m', 'analysis_sql', 'lint', 'postgres'])
  expect(seen.input).toBe(CTE_SQL)
  expect(await ws.list('queries')).toEqual([])
  expect(ws.assay.runsClaimed).toBe(0)
  expect(ws.runs.some(argv => argv[0] === 'rds-psql')).toBe(false)
  // The next statement that passes takes number 001.
  scripted(ws, { errors: [], warnings: [] })
  expect(await ws.call('sql', { sql: CTE_SQL, slug: 'fixed' })).toBe('Query 001: 1 row. Columns: x\nx\n1')
  await ws.done()
})

test('a statement that passes runs as usual, and its warnings follow the reply', async () => {
  const ws = await fake(FILES)
  scripted(ws, { errors: [], warnings: ['CTE spend_per_customer: joins and aggregates; do one of filter, join, aggregate per CTE.'] })
  const reply = await ws.call('sql', { sql: CTE_SQL, slug: 'spend' })
  expect(reply).toBe('Query 001: 1 row. Columns: x\nx\n1\n\nSQL rule warnings:\n- CTE spend_per_customer: joins and aggregates; do one of filter, join, aggregate per CTE.')
  expect(lintRuns(ws)[0]?.at(-1)).toBe('databricks')
  expect(await ws.file('queries/001_spend.sql')).toBe(`${CTE_SQL}\n`)
  await ws.done()
})

test('a plain statement, with no WITH and no JOIN, is not linted', async () => {
  const ws = await fake(FILES)
  scripted(ws, { errors: ['never'], warnings: [] })
  expect(await ws.call('sql', { sql: 'SELECT x FROM t', slug: 'plain' })).toBe('Query 001: 1 row. Columns: x\nx\n1')
  expect(lintRuns(ws)).toEqual([])
  await ws.done()
})

test('a lint that cannot run does not block: the query runs and the reply says why it was not checked', async () => {
  const ws = await fake(FILES)
  scripted(ws, { exitCode: 1, stdout: '{"error": "the SQL does not parse: Expecting )"}' })
  expect(await ws.call('sql', { sql: 'SELECT * FROM a JOIN (', slug: 'bad' })).toBe('Query 001: 1 row. Columns: x\nx\n1\n\nSQL rules not checked: the SQL does not parse: Expecting )')
  await ws.done()
  const bare = await fake()
  bare.setRun(answering([['1']], ['x']))
  expect(await bare.call('sql', { sql: CTE_SQL, slug: 'x' })).toBe(`Query 001: 1 row. Columns: x\nx\n1\n\nSQL rules not checked: ${VENV_MISSING}`)
  await bare.done()
})

test("the analyst's own runs are not linted", async () => {
  const ws = await fake(FILES)
  scripted(ws, { errors: ['never'], warnings: [] })
  expect(await runSql(ws.assay, { sql: CTE_SQL, slug: 'mine', engine: 'databricks' })).toBe('Query 001: 1 row. Columns: x\nx\n1')
  expect(lintRuns(ws)).toEqual([])
  await ws.done()
})

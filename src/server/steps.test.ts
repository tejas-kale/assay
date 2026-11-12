// The steps request (docs/slice-9.md, slice 9c): the server plans a SQL run with `analysis_sql steps`, runs each step's
// preview and counts queries on the run's engine, and saves progress next to the run as `queries/NNN.steps.json`.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { parseSteps } from '../core/steps.ts'
import type { StepsFile } from '../core/steps.ts'
import { fake } from './testing.ts'
import type { Fake } from './testing.ts'

const FILES = { 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay/bin/python': '', 'queries/042_spend.sql': '-- author: user\nSELECT 1\n', 'queries/042_spend.csv': 'x\n1\n' }
const GRAPH = { nodes: [{ id: 't', kind: 'table', name: 't' }, { id: 'clean', kind: 'cte', name: 'clean', grain: ['id'] }, { id: 'final', kind: 'final', name: 'Final SELECT', grain: [] }], edges: [] }
const PLAN = {
  lineage: GRAPH,
  steps: [
    { k: 1, name: 'clean', node: 1, preview: 'WITH clean AS (SELECT 1) SELECT * FROM clean LIMIT 50', counts: 'SELECT 1 AS assay_rows', grain: ['id'] },
    { k: 2, name: 'final', node: 2, preview: null, counts: 'SELECT 2 AS assay_rows', grain: [] },
  ],
}
const HEADERS = ['assay_rows', 'assay_grain_rows']

const output = (columns: string[], rows: string[][]) => ({ stdout: JSON.stringify([{ state: 'SUCCEEDED', columns, rows }, { state: 'SUCCEEDED', columns: ['1'], rows: [['1']] }]) })
const fileOf = (argv: readonly string[]) => argv[argv.indexOf('--file') + 1] ?? ''

type Script = { plan?: object; counts?: Record<string, string[]>; failOn?: string; onQuery?: (file: string) => Promise<void> }
const notices = async (ws: Fake) => JSON.parse((await ws.file('.assay/step-notices.json')) ?? '[]') as string[]

/** Plays the helper and the warehouse; notes the steps file as each query starts. */
function script(ws: Fake, how: Script = {}, seen: string[][] = []) {
  ws.setRun(async argv => {
    if (argv[3] === 'analysis_sql') return { stdout: JSON.stringify(how.plan ?? PLAN) }
    // rds-psql (Postgres) prints CSV and takes the file after -f.
    if (argv[0] === 'rds-psql') return { stdout: 'assay_rows,assay_grain_rows\n5,5\n' }
    const file = fileOf(argv)
    const steps = parseSteps((await ws.file('queries/042.steps.json')) ?? '')
    seen.push(steps?.steps.map(step => step.status) ?? [])
    await how.onQuery?.(file)
    if (how.failOn && file.includes(how.failOn)) return { stdout: JSON.stringify({ error: 'boom' }), exitCode: 1, stderr: 'boom' }
    if (file.endsWith('.counts.sql')) {
      const row = how.counts?.[file.split('/').pop()?.split('.')[1]?.split('_')[0] ?? ''] ?? ['5', '5']
      return output(HEADERS, [row])
    }
    return output(['id'], [['1'], ['2']])
  })
}

const read = async (ws: Fake): Promise<StepsFile | undefined> => parseSteps((await ws.file('queries/042.steps.json')) ?? '')
const ask = (ws: Fake, run = 42) => ws.requests.perform({ kind: 'steps', run })

test('steps run in order: every step goes pending, running, ok, and the file is rewritten at each change', async () => {
  const ws = await fake(FILES)
  const seen: string[][] = []
  script(ws, {}, seen)
  expect(await ask(ws)).toEqual({ ok: true })
  // Seen as each query starts: the step being run is `running`, the later ones `pending`, the earlier ones `ok`.
  expect(seen).toEqual([['running', 'pending'], ['running', 'pending'], ['ok', 'running']])
  const done = await read(ws)
  expect(done?.status).toBe('done')
  expect(done?.steps.map(step => [step.k, step.name, step.node, step.status, step.rows])).toEqual([[1, 'clean', 1, 'ok', 5], [2, 'final', 2, 'ok', 5]])
  expect(JSON.parse((await ws.file('queries/042.lineage.json')) ?? 'null')).toEqual(GRAPH)
  expect(await ws.list('queries')).toEqual(['queries/042.1_clean.counts.sql', 'queries/042.1_clean.csv', 'queries/042.1_clean.sql', 'queries/042.2_final.counts.sql', 'queries/042.lineage.json', 'queries/042.steps.json', 'queries/042_spend.csv', 'queries/042_spend.sql'])
  expect(await ws.file('queries/042.1_clean.sql')).toBe('WITH clean AS (SELECT 1) SELECT * FROM clean LIMIT 50\n')
  expect(await ws.file('queries/042.1_clean.csv')).toBe('id\n1\n2\n')
  expect(await ws.file('queries/042.1_clean.counts.sql')).toBe('SELECT 1 AS assay_rows\n')
  await ws.done()
})

test('the plan comes from the run body with the run engine, and Postgres steps carry the mark and run in psql', async () => {
  const ws = await fake({ ...FILES, 'queries/042_spend.sql': '-- author: user\n-- postgres\nSELECT 1\n' })
  script(ws)
  await ask(ws)
  const planned = ws.runs.find(argv => argv[3] === 'analysis_sql')
  expect(planned?.slice(4)).toEqual(['steps', 'postgres'])
  expect(await ws.file('queries/042.1_clean.sql')).toBe('-- postgres\nWITH clean AS (SELECT 1) SELECT * FROM clean LIMIT 50\n')
  expect(ws.runs.filter(argv => argv[0] === 'rds-psql').length).toBe(3)
  await ws.done()
})

test('a failing step is error with the message, the steps after it are skipped and no more queries run', async () => {
  const ws = await fake(FILES)
  script(ws, { failOn: '042.1_clean.sql' })
  expect(await ask(ws)).toEqual({ ok: true })
  const done = await read(ws)
  expect(done?.steps.map(step => step.status)).toEqual(['error', 'skipped'])
  expect(done?.status).toBe('error')
  expect(done?.steps[0]?.error).toBeDefined()
  expect(ws.runs.filter(argv => argv[0] === 'databricks').length).toBe(1)
  await ws.done()
})

test('a re-run removes the earlier step files first', async () => {
  const ws = await fake({ ...FILES, 'queries/042.7_old.csv': 'x\n', 'queries/042.7_old.sql': 'x', 'queries/042.7_old.counts.sql': 'x', 'queries/043.1_other.csv': 'keep\n' })
  script(ws)
  await ask(ws)
  const names = await ws.list('queries')
  expect(names.filter(name => name.includes('old'))).toEqual([])
  expect(names).toContain('queries/043.1_other.csv')
  await ws.done()
})

test('a failed check is appended to step-notices.json as one line, kept across runs', async () => {
  const ws = await fake(FILES)
  script(ws, { counts: { 1: ['5', '3'], 2: ['1', '1'] } })
  await ask(ws)
  const lines = await notices(ws)
  expect(lines).toEqual(['q042 step clean: grain id has 2 duplicate rows.'])
  const done = await read(ws)
  expect(done?.steps[0]?.checks).toEqual([{ kind: 'grain', ok: false, text: 'grain id has 2 duplicate rows' }])
  await ask(ws)
  expect((await notices(ws)).length).toBe(2)
  await ws.done()
})

test('a failed check is in step-notices.json before the next step runs, so a stopped server keeps it', async () => {
  const ws = await fake(FILES)
  let atSecond: string[] | undefined
  script(ws, {
    counts: { 1: ['5', '3'], 2: ['1', '1'] },
    onQuery: async file => {
      if (file.includes('2_final')) atSecond = await notices(ws)
    },
  })
  await ask(ws)
  expect(atSecond).toEqual(['q042 step clean: grain id has 2 duplicate rows.'])
  await ws.done()
})

test('steps never claim a run number or touch runs.json and failures', async () => {
  const ws = await fake(FILES)
  script(ws, { failOn: '042.1_clean.sql' })
  await ask(ws)
  expect(await ws.status()).toEqual(null)
  expect([...ws.assay.failures]).toEqual([])
  expect(ws.assay.runsClaimed).toBe(0)
  expect((await ws.list('queries')).filter(name => /queries\/\d+_/.test(name))).toEqual(['queries/042_spend.csv', 'queries/042_spend.sql'])
  await ws.done()
})

test('a trusted SQL run gets its lineage and a note, and no step runs', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay/bin/python': '', 'queries/042_weekly.sql': '-- trusted: weekly\n-- commit: abc\n-- args: {}\nSELECT 1 FROM t WHERE d > :since\n' })
  script(ws, { plan: GRAPH })
  expect(await ask(ws)).toEqual({ ok: true })
  expect(ws.runs.map(argv => argv.slice(4))).toEqual([['lineage', 'databricks', '--template']])
  expect(await read(ws)).toEqual({ run: 42, status: 'done', note: "Steps run only SQL written in the run: a trusted calculation's arguments are not replayed.", steps: [] })
  expect(JSON.parse((await ws.file('queries/042.lineage.json')) ?? 'null')).toEqual(GRAPH)
  await ws.done()
})

test('a plan with no steps writes the lineage and the plan note', async () => {
  const ws = await fake(FILES)
  script(ws, { plan: { lineage: GRAPH, steps: [], note: 'There is no CTE: nothing to step through.' } })
  await ask(ws)
  expect(await read(ws)).toEqual({ run: 42, status: 'done', note: 'There is no CTE: nothing to step through.', steps: [] })
  expect(JSON.parse((await ws.file('queries/042.lineage.json')) ?? 'null')).toEqual(GRAPH)
  expect(ws.runs.filter(argv => argv[0] === 'databricks')).toEqual([])
  await ws.done()
})

test('a plan that does not parse is the lineage error and a steps file in error', async () => {
  const ws = await fake(FILES)
  script(ws, { plan: { error: 'the SQL does not parse: x' } })
  expect(await ask(ws)).toEqual({ ok: true })
  expect(JSON.parse((await ws.file('queries/042.lineage.json')) ?? '{}')).toEqual({ error: 'the SQL does not parse: x' })
  expect(await read(ws)).toEqual({ run: 42, status: 'error', note: 'the SQL does not parse: x', steps: [] })
  await ws.done()
})

test('a missing run is an error reply, and a Python run gets the lineage error only', async () => {
  const ws = await fake({ ...FILES, 'queries/043_calc.py': 'x = 1\n' })
  script(ws)
  expect(await ask(ws, 9)).toEqual({ error: 'No run 009.' })
  expect(await ask(ws, 43)).toEqual({ ok: true })
  expect(JSON.parse((await ws.file('queries/043.lineage.json')) ?? '{}')).toEqual({ error: 'Steps reads SQL runs.' })
  expect(ws.runs).toEqual([])
  await ws.done()
})

test('a steps request through the request files is queued and answered', async () => {
  const ws = await fake(FILES)
  script(ws)
  await ws.put('.assay/requests/0000000000001-aaaaaa.json', JSON.stringify({ id: '0000000000001-aaaaaa', kind: 'steps', run: 42 }))
  await ws.requests.poll()
  expect(JSON.parse((await ws.file('.assay/replies/0000000000001-aaaaaa.json')) ?? '{}')).toEqual({ id: '0000000000001-aaaaaa', ok: true })
  await ws.done()
})

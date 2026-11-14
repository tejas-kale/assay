import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { test } from 'node:test'

import { PREFACE_ARCHIVE_DIR, PREFACE_DRAFT_FILE, freezePreface, parseFrozenPreface, resetPreface } from '../core/preface.ts'
import type { PrefaceFs } from '../core/preface.ts'
import { parseRunHeader, parseRunStatus } from '../core/runs.ts'
import { parseSteps } from '../core/steps.ts'
import { readQueryNames, readRunsWithHeaders } from '../main/runFiles.ts'
import { expect } from '../testing/expect.ts'
import { TOOLS } from './tools.ts'
import { RUNNER, answering, fake } from './testing.ts'
import type { Fake } from './testing.ts'

const diskFs: PrefaceFs = {
  readdir: path => readdir(path),
  mkdir: async path => {
    await mkdir(path, { recursive: true })
  },
  readFile: path => readFile(path, 'utf8'),
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  },
  unlink: path => unlink(path),
}

const DRAFT = {
  low: 0.12,
  high: 0.18,
  known_total: 1250,
  tolerance: 5,
  falsifiers: ['The rollout matches the backtest.'],
  answer: 'rollout-rate',
  reconciliation: 'rollout-total',
  specs: [
    { id: 'rollout-rate', text: 'The spec you approved, in prose.' },
    { id: 'rollout-total', text: 'The reconciliation spec you approved, in prose.' },
  ],
}

const CALC = {
  name: 'completes_by_site',
  kind: 'sql',
  file: 'completes_by_site.sql',
  description: 'Completes per site.',
  parameters: [],
  sql: 'SELECT site_id, count(*) AS completes FROM main.panel.surveys GROUP BY site_id',
  commit: 'abc123def456',
  dirty: false,
}

function wireTools(ws: Fake) {
  const python = `${ws.venv}/bin/python`
  ws.setRun(argv => {
    if (argv[1] === RUNNER && argv[2] === 'run') {
      return { stdout: `${JSON.stringify({ status: 'ok', stdout: '1\n', tables: [], plots: [], reads: [] })}\n` }
    }
    if (argv[0] === python && argv[4] === 'analysis_trust') {
      const cmd = argv[5]
      if (cmd === 'list') return { stdout: JSON.stringify({ calculations: [CALC], problems: [] }) }
      if (cmd === 'run') return { stdout: JSON.stringify({ columns: ['site_id', 'completes'], rows: [['10', '2']] }) }
      return { stdout: JSON.stringify({ tables: [], glossary: {} }) }
    }
    return answering([['1']], ['n'])(argv)
  })
}

test('runs record the current frozen preface id across SQL, Python and trusted runs, and omit it when none is frozen', async () => {
  const ws = await fake({
    'analysis.yaml': 'title: Feature\n',
    '.venv/bin/python': '',
    '/opt/venv-assay/bin/python': '',
  })
  wireTools(ws)
  await ws.assay.kernels.start()

  await ws.call('sql', { sql: '-- preface: forged\nSELECT 1 AS n', slug: 'before freeze' })
  const q1 = await ws.file('queries/001_before-freeze.sql')
  expect(q1).toBe('SELECT 1 AS n\n')
  expect(parseRunHeader(q1 ?? '').preface).toBeUndefined()

  await ws.put(PREFACE_DRAFT_FILE, JSON.stringify(DRAFT, null, 2))
  const first = await freezePreface(diskFs, ws.analysis, new Date('2026-11-14T10:00:00.000Z'))
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error('expected first freeze to succeed')

  await ws.call('sql', { sql: 'SELECT 2 AS n', slug: 'sql under first' })
  await ws.call('python', { code: '# preface: forged\nprint(1)', slug: 'py under first' })
  await ws.call('trusted', { name: 'completes_by_site' })

  const q2 = await ws.file('queries/002_sql-under-first.sql')
  const q3 = await ws.file('queries/003_py-under-first.py')
  const q4 = await ws.file('queries/004_completes-by-site.sql')
  expect(parseRunHeader(q2 ?? '', 'sql')).toEqual({ author: 'claude', engine: 'databricks', preface: first.preface.id })
  expect(parseRunHeader(q3 ?? '', 'python')).toEqual({ author: 'claude', engine: 'databricks', preface: first.preface.id })
  expect(parseRunHeader(q4 ?? '', 'sql')).toEqual({
    author: 'claude',
    engine: 'databricks',
    trusted: 'completes_by_site',
    preface: first.preface.id,
  })
  await ws.done()
})

test('after reset and a second frozen preface, earlier runs keep the first preface id and new runs report the second', async () => {
  const ws = await fake({
    'analysis.yaml': 'title: Feature\n',
    '.venv/bin/python': '',
    '/opt/venv-assay/bin/python': '',
  })
  wireTools(ws)
  await ws.assay.kernels.start()

  await ws.put(PREFACE_DRAFT_FILE, JSON.stringify(DRAFT, null, 2))
  const first = await freezePreface(diskFs, ws.analysis, new Date('2026-11-14T10:00:00.000Z'))
  if (!first.ok) throw new Error('expected first freeze to succeed')
  await ws.call('sql', { sql: 'SELECT 1 AS n', slug: 'under first' })

  const reset = await resetPreface(diskFs, ws.analysis)
  expect(reset.ok).toBe(true)
  await ws.call('sql', { sql: 'SELECT 2 AS n', slug: 'between prefaces' })

  await ws.put(PREFACE_DRAFT_FILE, JSON.stringify({ ...DRAFT, low: 0.2, high: 0.3 }, null, 2))
  const second = await freezePreface(diskFs, ws.analysis, new Date('2026-11-14T11:00:00.000Z'))
  if (!second.ok) throw new Error('expected second freeze to succeed')
  expect(second.preface.id).not.toBe(first.preface.id)

  await ws.call('sql', { sql: 'SELECT 3 AS n', slug: 'sql under second' })
  await ws.call('python', { code: 'print(3)', slug: 'py under second' })

  const runs = await readRunsWithHeaders(ws.analysis, await readQueryNames(ws.analysis))
  expect(runs.map(run => ({ number: run.number, preface: run.preface }))).toEqual([
    { number: 1, preface: first.preface.id },
    { number: 2, preface: undefined },
    { number: 3, preface: second.preface.id },
    { number: 4, preface: second.preface.id },
  ])

  const archived = await ws.file(`${PREFACE_ARCHIVE_DIR}/${first.preface.id}.json`)
  expect(parseFrozenPreface(archived ?? '')).toEqual(first.preface)
  await ws.done()
})

const STEP_GRAPH = {
  nodes: [
    { id: 't', kind: 'table', name: 't' },
    { id: 'clean', kind: 'cte', name: 'clean', grain: ['id'] },
    { id: 'final', kind: 'final', name: 'Final SELECT', grain: ['id'] },
  ],
  edges: [],
}

const STEP_PLAN = {
  lineage: STEP_GRAPH,
  steps: [
    { k: 1, name: 'clean', node: 1, preview: 'WITH clean AS (SELECT 1 AS id) SELECT * FROM clean LIMIT 50', counts: 'SELECT 1 AS assay_rows', grain: ['id'] },
    { k: 2, name: 'final', node: 2, preview: null, counts: 'SELECT 1 AS assay_rows', grain: ['id'] },
  ],
}

const CTE_SQL = '-- grain: id\nWITH clean AS (SELECT 1 AS id)\n-- grain: id\nSELECT id FROM clean'
const warehouseOut = (columns: string[], rows: string[][]) => ({
  stdout: JSON.stringify([
    { state: 'SUCCEEDED', columns, rows },
    { state: 'SUCCEEDED', columns: ['1'], rows: [['1']] },
  ]),
})

function wireSpecSql(ws: Fake, options: { failStepCountsOn?: string } = {}) {
  ws.setRun(argv => {
    if (argv[4] === 'analysis_sql') {
      const sub = argv[5]
      if (sub === 'lint') return { stdout: JSON.stringify({ errors: [], warnings: [] }) }
      if (sub === 'retype') return { stdout: JSON.stringify({ warnings: [] }) }
      if (sub === 'steps') return { stdout: JSON.stringify(STEP_PLAN) }
    }
    if (argv[4] === 'analysis_trust') return { stdout: JSON.stringify({ tables: [], glossary: {} }) }
    const file = argv[argv.indexOf('--file') + 1] ?? ''
    if (options.failStepCountsOn && file.includes(options.failStepCountsOn)) {
      return { stdout: JSON.stringify({ error: 'step count boom' }), exitCode: 1, stderr: 'step count boom' }
    }
    if (file.endsWith('.counts.sql')) return warehouseOut(['assay_rows', 'assay_grain_rows'], [['7', '7']])
    return warehouseOut(['id'], [['1']])
  })
}

test('sql with a frozen spec id runs automatic step counts; exploration sql without a spec id skips them', async () => {
  const specProp = TOOLS.find(tool => tool.name === 'sql')?.inputSchema.properties
  expect(specProp && 'spec' in specProp).toBe(true)

  const ws = await fake({
    'analysis.yaml': 'title: Feature\n',
    '.venv/bin/python': '',
    '/opt/venv-assay/bin/python': '',
  })
  wireSpecSql(ws)
  await ws.put(PREFACE_DRAFT_FILE, JSON.stringify(DRAFT, null, 2))
  const frozen = await freezePreface(diskFs, ws.analysis, new Date('2026-11-14T10:00:00.000Z'))
  if (!frozen.ok) throw new Error('expected freeze to succeed')

  await ws.call('sql', { sql: `-- spec: rollout-rate\n${CTE_SQL}`, slug: 'explore' })
  expect(await ws.file('queries/001.steps.json')).toBeUndefined()
  expect(parseRunHeader((await ws.file('queries/001_explore.sql')) ?? '').spec).toBeUndefined()

  const reply = await ws.call('sql', { sql: CTE_SQL, slug: 'answer', spec: 'rollout-rate' })
  expect(reply).toContain('Query 002: 1 row.')
  const q2 = await ws.file('queries/002_answer.sql')
  expect(parseRunHeader(q2 ?? '')).toEqual({
    author: 'claude',
    engine: 'databricks',
    preface: frozen.preface.id,
    spec: 'rollout-rate',
    specFrozen: true,
  })
  const steps = parseSteps((await ws.file('queries/002.steps.json')) ?? '')
  expect(steps?.status).toBe('done')
  expect(steps?.steps.map(step => [step.k, step.name, step.status, step.rows])).toEqual([
    [1, 'clean', 'ok', 7],
    [2, 'final', 'ok', 7],
  ])
  expect(await ws.file('queries/002.1_clean.counts.sql')).toBe('SELECT 1 AS assay_rows\n')
  expect(await ws.file('queries/002.2_final.counts.sql')).toBe('SELECT 1 AS assay_rows\n')
  await ws.done()
})

test('sql with an unfrozen spec id still executes and runs step counts, marking the run as unfrozen', async () => {
  const ws = await fake({
    'analysis.yaml': 'title: Feature\n',
    '.venv/bin/python': '',
    '/opt/venv-assay/bin/python': '',
  })
  wireSpecSql(ws)

  await ws.call('sql', { sql: CTE_SQL, slug: 'no preface yet', spec: 'rollout-rate' })
  const q1 = await ws.file('queries/001_no-preface-yet.sql')
  expect(parseRunHeader(q1 ?? '')).toEqual({
    author: 'claude',
    engine: 'databricks',
    spec: 'rollout-rate',
    specFrozen: false,
  })
  expect(parseSteps((await ws.file('queries/001.steps.json')) ?? '')?.steps.map(step => step.rows)).toEqual([7, 7])

  await ws.put(PREFACE_DRAFT_FILE, JSON.stringify(DRAFT, null, 2))
  const frozen = await freezePreface(diskFs, ws.analysis, new Date('2026-11-14T10:00:00.000Z'))
  if (!frozen.ok) throw new Error('expected freeze to succeed')

  await ws.call('sql', { sql: CTE_SQL, slug: 'unlisted spec', spec: 'ad-hoc-spec' })
  const runs = await readRunsWithHeaders(ws.analysis, await readQueryNames(ws.analysis))
  expect(runs.map(run => ({ number: run.number, spec: run.spec, specFrozen: run.specFrozen, steps: run.steps }))).toEqual([
    { number: 1, spec: 'rollout-rate', specFrozen: false, steps: 2 },
    { number: 2, spec: 'ad-hoc-spec', specFrozen: false, steps: 2 },
  ])
  expect(parseSteps((await ws.file('queries/002.steps.json')) ?? '')?.steps.map(step => step.rows)).toEqual([7, 7])
  await ws.done()
})

test('a failed automatic step-count pass leaves the SQL run recorded with its result and the counts missing', async () => {
  const ws = await fake({
    'analysis.yaml': 'title: Feature\n',
    '.venv/bin/python': '',
    '/opt/venv-assay/bin/python': '',
  })
  wireSpecSql(ws, { failStepCountsOn: '001.1_clean.counts.sql' })
  await ws.put(PREFACE_DRAFT_FILE, JSON.stringify(DRAFT, null, 2))
  await freezePreface(diskFs, ws.analysis, new Date('2026-11-14T10:00:00.000Z'))

  const reply = await ws.call('sql', { sql: CTE_SQL, slug: 'count fail', spec: 'rollout-rate' })
  expect(reply).toContain('Query 001: 1 row.')
  expect(await ws.file('queries/001_count-fail.csv')).toBe('id\n1\n')
  expect(parseRunStatus((await ws.file('.assay/runs.json')) ?? '')).toEqual({ failed: {} })

  const steps = parseSteps((await ws.file('queries/001.steps.json')) ?? '')
  expect(steps?.status).toBe('error')
  expect(steps?.steps.map(step => [step.k, step.status, step.rows])).toEqual([
    [1, 'error', undefined],
    [2, 'skipped', undefined],
  ])
  await ws.done()
})

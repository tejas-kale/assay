import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { test } from 'node:test'

import { PREFACE_ARCHIVE_DIR, PREFACE_DRAFT_FILE, freezePreface, parseFrozenPreface, resetPreface } from '../core/preface.ts'
import type { PrefaceFs } from '../core/preface.ts'
import { parseRunHeader } from '../core/runs.ts'
import { readQueryNames, readRunsWithHeaders } from '../main/runFiles.ts'
import { expect } from '../testing/expect.ts'
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

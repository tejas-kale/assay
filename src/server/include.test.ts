// Include by name (specs/slices/slice-10.md, slice 10c): SQL naming trusted blocks and definitions is expanded by
// `analysis_sql expand` before it runs; the run keeps the SQL as written under a `-- built from:` line, the expanded SQL
// beside it, and Steps reads the expanded SQL with each block as one step.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { parseRunHeader } from '../core/runs.ts'
import { parseSteps } from '../core/steps.ts'
import type { Expansion } from './sqlRun.ts'
import type { RunOptions } from './proc.ts'
import { fake } from './testing.ts'
import type { Fake } from './testing.ts'

const FILES = { 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay/bin/python': '' }
const WRITTEN = `WITH
-- grain: session_id
sessions AS ({{ client_entry_sessions(start => '2026-11-01', end => '2026-11-08') }}),
-- grain: buyer_id
buyers AS ({{ all_buyers() }})
-- grain: buyer_id
SELECT b.buyer_id, count(*) AS n FROM sessions s
-- join: many:1 on buyer_id
JOIN buyers b ON b.buyer_id = s.buyer_id
GROUP BY b.buyer_id`
const EXPANSION: Expansion = {
  retype_sql: WRITTEN.replace(/\{\{ client_entry_sessions\([^)]*\) \}\}/, 'SELECT session_id, buyer_id FROM client_entry_sessions').replace('{{ all_buyers() }}', 'SELECT buyer_id FROM all_buyers'),
  sql: WRITTEN.replace(/\{\{ client_entry_sessions\([^)]*\) \}\}/, 'SELECT session_id, buyer_id FROM cint.mkt.sessions AS s WHERE (s.lk_responsestatusid = 3)').replace('{{ all_buyers() }}', 'SELECT buyer_id FROM cint.mkt.buyers'),
  lint_sql: WRITTEN.replace(/\{\{ client_entry_sessions\([^)]*\) \}\}/, 'SELECT session_id, buyer_id FROM client_entry_sessions').replace('{{ all_buyers() }}', 'SELECT buyer_id FROM all_buyers'),
  built_from: [
    { name: 'client_entry_sessions', kind: 'block', commit: '1a2b3c4d5e6f' },
    { name: 'cint.mkt.sessions:client_entry', kind: 'definition', commit: 'aaaaaaaaaaaa' },
    { name: 'all_buyers', kind: 'block', commit: 'bbbbbbbbbbbb' },
  ],
  blocks: [
    { cte: 'sessions', name: 'client_entry_sessions' },
    { cte: 'buyers', name: 'all_buyers' },
  ],
}

const GRAPH = {
  nodes: [
    { id: 'sessions', kind: 'cte', name: 'sessions', grain: ['session_id'], block: 'client_entry_sessions' },
    { id: 'buyers', kind: 'cte', name: 'buyers', grain: ['buyer_id'], block: 'all_buyers' },
    { id: 'final', kind: 'final', name: 'Final SELECT', grain: ['buyer_id'] },
  ],
  edges: [],
}
const PLAN = {
  lineage: GRAPH,
  steps: [
    { k: 1, name: 'sessions', node: 0, preview: 'SELECT 1', counts: 'SELECT 1', grain: ['session_id'], block: 'client_entry_sessions' },
    { k: 2, name: 'buyers', node: 1, preview: 'SELECT 1', counts: 'SELECT 1', grain: ['buyer_id'], block: 'all_buyers' },
    { k: 3, name: 'final', node: 2, preview: null, counts: 'SELECT 1', grain: ['buyer_id'] },
  ],
}

const output = (columns: string[], rows: string[][]) => ({ stdout: JSON.stringify([{ state: 'SUCCEEDED', columns, rows }, { state: 'SUCCEEDED', columns: ['1'], rows: [['1']] }]) })
const fileOf = (argv: readonly string[]) => argv[argv.indexOf('--file') + 1] ?? ''

type Seen = { helper: { argv: readonly string[]; input?: string }[]; queried: string[] }

/** Plays the helper (expand, lint, steps) and the warehouse. */
function script(ws: Fake, expansion: object = EXPANSION, seen: Seen = { helper: [], queried: [] }, retypes: string[] = []) {
  ws.setRun((argv, options?: RunOptions) => {
    if (argv[4] === 'analysis_sql') {
      seen.helper.push({ argv, ...(options?.input === undefined ? {} : { input: options.input }) })
      if (argv[5] === 'expand') return { stdout: JSON.stringify(expansion) }
      if (argv[5] === 'lint') return { stdout: JSON.stringify({ errors: [], warnings: [] }) }
      if (argv[5] === 'retype') return { stdout: JSON.stringify({ warnings: retypes }) }
      if (argv[5] === 'steps') return { stdout: JSON.stringify(PLAN) }
      return { stdout: '{}' }
    }
    if (argv[4] === 'analysis_trust') return { stdout: JSON.stringify({ tables: [], glossary: {} }) }
    const file = fileOf(argv)
    seen.queried.push(file)
    if (file.endsWith('.counts.sql')) return output(['assay_rows', 'assay_grain_rows'], [['4', '4']])
    return output(['buyer_id', 'n'], [['10', '2']])
  })
  return seen
}

test("Claude's query with includes runs expanded: the run keeps the SQL as written, built from, and the expanded SQL", async () => {
  const ws = await fake(FILES)
  const seen = script(ws)
  const reply = await ws.call('sql', { sql: WRITTEN, slug: 'by-buyer' })
  expect(reply.split('\n')[0]).toBe('Built from: client_entry_sessions (block), cint.mkt.sessions:client_entry (definition), all_buyers (block).')
  expect(reply.split('\n')[1]).toBe('Query 001: 1 row. Columns: buyer_id, n')
  expect(seen.helper[0]?.argv.slice(5)).toEqual(['expand', 'databricks', ws.root])
  expect(seen.helper[0]?.input).toBe(WRITTEN)
  // The rules read the SQL as written, each block body a plain select.
  expect(seen.helper[1]?.argv[5]).toBe('lint')
  expect(seen.helper[1]?.input).toBe(EXPANSION.lint_sql)
  const saved = (await ws.file('queries/001_by-buyer.sql')) ?? ''
  expect(saved).toBe(`-- built from: client_entry_sessions@1a2b3c4d5e6f, cint.mkt.sessions:client_entry@aaaaaaaaaaaa, all_buyers@bbbbbbbbbbbb\n${WRITTEN}\n`)
  expect(parseRunHeader(saved).builtFrom).toEqual(['client_entry_sessions@1a2b3c4d5e6f', 'cint.mkt.sessions:client_entry@aaaaaaaaaaaa', 'all_buyers@bbbbbbbbbbbb'])
  expect(await ws.file('queries/001.expanded.sql')).toBe(`-- blocks: sessions=client_entry_sessions,buyers=all_buyers\n${EXPANSION.sql}\n`)
  expect(seen.queried).toEqual(['queries/001.expanded.sql'])
  await ws.done()
})

test('a query whose includes cannot be used is not run: no number, the reply lists each problem', async () => {
  const ws = await fake(FILES)
  script(ws, { errors: ['{{ nothing(s) }}: no trusted block or definition named nothing.'] })
  const reply = await ws.call('sql', { sql: 'SELECT * FROM t s WHERE {{ nothing(s) }}', slug: 'x' })
  expect(reply).toBe('Not run: the included trusted pieces cannot be used. Fix and send again:\n- {{ nothing(s) }}: no trusted block or definition named nothing.')
  expect(await ws.list('queries')).toEqual([])
  expect(ws.assay.runsClaimed).toBe(0)
  await ws.done()
})

test("the analyst's runs expand too, and a failed expansion is the request's error", async () => {
  const ws = await fake(FILES)
  const seen = script(ws)
  expect(await ws.requests.perform({ kind: 'sql', sql: WRITTEN, slug: 'mine', engine: 'databricks' })).toEqual({ number: 1 })
  expect(seen.queried).toEqual(['queries/001.expanded.sql'])
  expect(seen.helper.some(call => call.argv[5] === 'lint')).toBe(false)
  script(ws, { errors: ['bad'] })
  expect(await ws.requests.perform({ kind: 'sql', sql: WRITTEN, slug: 'mine', engine: 'databricks' })).toEqual({ error: 'Not run: the included trusted pieces cannot be used. Fix and send again:\n- bad' })
  await ws.done()
})

test('SQL without includes is not expanded', async () => {
  const ws = await fake(FILES)
  const seen = script(ws)
  await ws.call('sql', { sql: 'SELECT 1 AS x', slug: 'plain' })
  expect(seen.helper.some(call => call.argv[5] === 'expand')).toBe(false)
  expect(await ws.file('queries/001.expanded.sql')).toBe(undefined)
  await ws.done()
})

test('end to end: a query including two blocks lists both and steps through each as one labelled step with its grain check', async () => {
  const ws = await fake(FILES)
  const seen = script(ws)
  const reply = await ws.call('sql', { sql: WRITTEN, slug: 'by-buyer' })
  expect(reply).toContain('client_entry_sessions (block)')
  expect(reply).toContain('all_buyers (block)')
  expect(await ws.requests.perform({ kind: 'steps', run: 1 })).toEqual({ ok: true })
  const planned = seen.helper.find(call => call.argv[5] === 'steps')
  // Steps read the expanded SQL (without its blocks line) and are told which CTE holds which block.
  expect(planned?.argv.slice(5)).toEqual(['steps', 'databricks', '--blocks', 'sessions=client_entry_sessions,buyers=all_buyers'])
  expect(planned?.input).toBe(`${EXPANSION.sql}\n`)
  const steps = parseSteps((await ws.file('queries/001.steps.json')) ?? '')
  expect(steps?.steps.map(step => [step.name, step.block, step.status, step.checks?.map(check => [check.kind, check.ok])])).toEqual([
    ['sessions', 'client_entry_sessions', 'ok', [['grain', true]]],
    ['buyers', 'all_buyers', 'ok', [['grain', true]]],
    ['final', undefined, 'ok', [['grain', true]]],
  ])
  await ws.done()
})

test('a retyped piece is a warning: the query runs, the reply lists it, and the run keeps it in NNN.notices.json', async () => {
  const ws = await fake(FILES)
  const line = 'retypes cint.mkt.sessions:client_entry (lk_responsestatusid = 3): include {{ client_entry(s) }}'
  const seen = script(ws, EXPANSION, { helper: [], queried: [] }, [line])
  const sql = 'SELECT count(*) AS n FROM cint.mkt.sessions s WHERE s.lk_responsestatusid = 3'
  const reply = await ws.call('sql', { sql, slug: 'n' })
  expect(reply).toBe(`Query 001: 1 row. Columns: buyer_id, n\nbuyer_id  n\n10        2\n\nRetyped trusted logic (include the piece, or add -- retype: <piece>: <why> above the statement):\n- ${line}`)
  const retype = seen.helper.find(call => call.argv[5] === 'retype')
  expect(retype?.argv.slice(5)).toEqual(['retype', 'databricks', ws.root])
  expect(retype?.input).toBe(sql)
  expect(JSON.parse((await ws.file('queries/001.notices.json')) ?? 'null')).toEqual({ rules: [], retype: [line] })
  await ws.done()
})

test('the retype check reads the SQL with its includes removed', async () => {
  const ws = await fake(FILES)
  const seen = script(ws)
  await ws.call('sql', { sql: WRITTEN, slug: 'by-buyer' })
  expect(seen.helper.find(call => call.argv[5] === 'retype')?.input).toBe(EXPANSION.retype_sql)
  expect(await ws.file('queries/001.notices.json')).toBe(undefined)
  await ws.done()
})

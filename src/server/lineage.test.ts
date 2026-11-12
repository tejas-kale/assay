// The lineage request (docs/slice-9.md, slice 9b): the server runs `python -m analysis_sql lineage` on a SQL run's body
// and saves the answer next to the run as `queries/NNN.lineage.json`.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import type { RunOptions } from './proc.ts'
import { fake } from './testing.ts'
import type { Fake } from './testing.ts'

const FILES = { 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay/bin/python': '' }
const GRAPH = { nodes: [{ id: 't', kind: 'table', name: 't' }, { id: 'final', kind: 'final', name: 'Final SELECT' }], edges: [{ from: 't', to: 'final' }] }
const lineageRuns = (ws: Fake) => ws.runs.filter(argv => argv[4] === 'analysis_sql')

/** The helper answers with `answer` and notes the SQL it was given. */
function scripted(ws: Fake, answer: object, seen: { input?: string } = {}) {
  ws.setRun((_argv, options?: RunOptions) => {
    if (options?.input !== undefined) seen.input = options.input
    return { stdout: JSON.stringify(answer) }
  })
}

const ask = (ws: Fake, run: number) => ws.requests.perform({ kind: 'lineage', run })

test('a lineage request writes the helper answer next to the run, and the SQL is the body without the header', async () => {
  const ws = await fake({ ...FILES, 'queries/002_spend.sql': '-- author: user\n-- from: 001\nSELECT 1 FROM t\n' })
  const seen: { input?: string } = {}
  scripted(ws, GRAPH, seen)
  expect(await ask(ws, 2)).toEqual({ ok: true })
  expect(JSON.parse((await ws.file('queries/002.lineage.json')) ?? 'null')).toEqual(GRAPH)
  expect(seen.input).toBe('SELECT 1 FROM t\n')
  expect(lineageRuns(ws)[0]).toEqual([`${ws.venv}/bin/python`, '-I', '-B', '-m', 'analysis_sql', 'lineage', 'databricks'])
  await ws.done()
})

test('a run that does not exist is an error reply and writes nothing', async () => {
  const ws = await fake(FILES)
  scripted(ws, GRAPH)
  expect(await ask(ws, 5)).toEqual({ error: 'No run 005.' })
  expect(await ws.list('queries')).toEqual([])
  await ws.done()
})

test('a Python run, and a trusted run that is Python, get an error file without calling the helper', async () => {
  const ws = await fake({ ...FILES, 'queries/001_calc.py': 'x = 1\n', 'queries/002_w.sql': '-- trusted: weekly\n-- python: weekly.py\n' })
  scripted(ws, GRAPH)
  expect(await ask(ws, 1)).toEqual({ ok: true })
  expect(await ask(ws, 2)).toEqual({ ok: true })
  expect(JSON.parse((await ws.file('queries/001.lineage.json')) ?? '{}')).toEqual({ error: 'Steps reads SQL runs.' })
  expect(JSON.parse((await ws.file('queries/002.lineage.json')) ?? '{}')).toEqual({ error: 'Steps reads SQL runs.' })
  expect(lineageRuns(ws)).toEqual([])
  await ws.done()
})

test('the engine follows the postgres header line', async () => {
  const ws = await fake({ ...FILES, 'queries/001_q.sql': '-- author: user\n-- postgres\nSELECT 1 FROM t\n' })
  scripted(ws, GRAPH)
  await ask(ws, 1)
  expect(lineageRuns(ws)[0]?.slice(5)).toEqual(['lineage', 'postgres'])
  await ws.done()
})

test('a trusted SQL run passes --template so its placeholders bind', async () => {
  const ws = await fake({ ...FILES, 'queries/001_w.sql': '-- trusted: weekly\n-- commit: abc\n-- args: {}\nSELECT 1 FROM t WHERE d > :since\n' })
  const seen: { input?: string } = {}
  scripted(ws, GRAPH, seen)
  await ask(ws, 1)
  expect(lineageRuns(ws)[0]?.slice(5)).toEqual(['lineage', 'databricks', '--template'])
  expect(seen.input).toBe('SELECT 1 FROM t WHERE d > :since\n')
  await ws.done()
})

test('a helper error is saved as the lineage error, and the reply is still ok', async () => {
  const ws = await fake({ ...FILES, 'queries/001_q.sql': 'SELECT FROM (\n' })
  scripted(ws, { error: 'the SQL does not parse: x' })
  expect(await ask(ws, 1)).toEqual({ ok: true })
  expect(JSON.parse((await ws.file('queries/001.lineage.json')) ?? '{}')).toEqual({ error: 'the SQL does not parse: x' })
  await ws.done()
})

test('a lineage request through the request files is taken while another run is going', async () => {
  const ws = await fake({ ...FILES, 'queries/001_q.sql': 'SELECT 1 FROM t\n' })
  scripted(ws, GRAPH)
  await ws.put('.assay/requests/0000000000001-aaaaaa.json', JSON.stringify({ id: '0000000000001-aaaaaa', kind: 'lineage', run: 1 }))
  await ws.requests.poll()
  expect(JSON.parse((await ws.file('.assay/replies/0000000000001-aaaaaa.json')) ?? '{}')).toEqual({ id: '0000000000001-aaaaaa', ok: true })
  await ws.done()
})

// The edges of the server's session state: helper output it cannot read, step counts that say nothing, trusted runs
// that fail, and a kernel that is replaced, stopped or never there. Each case as the server answers it today.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { parseSteps } from '../core/steps.ts'
import type { RunOptions } from './proc.ts'
import { answering, fake, READY, RUNNER, until } from './testing.ts'
import type { Fake } from './testing.ts'

const FILES = { 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay/bin/python': '' }
const sqlHelper = (argv: readonly string[]) => argv[2] === 'analysis_sql'
const trustHelper = (argv: readonly string[]) => argv[2] === 'analysis_trust'
const kernelState = async (ws: Fake) => (await ws.status())?.kernel

// ---------------------------------------------------------------------------
// Starting a session, and the helpers.

test('start sets up the files and starts the kernel', async () => {
  const ws = await fake(FILES)
  await ws.assay.start()
  expect(await ws.file('threads.md')).toBeDefined()
  expect(ws.serves.length).toBe(1)
  await ws.done()
})

test('a helper printing JSON that is not an object, or nothing, is an error naming its exit', async () => {
  const ws = await fake(FILES)
  ws.setRun(argv => (sqlHelper(argv) ? { stdout: '3' } : answering([['1']], ['n'])(argv)))
  expect(await ws.call('sql', { sql: 'WITH x AS (SELECT 1) SELECT * FROM x', slug: 'x' })).toContain('SQL rules not checked: 3')
  ws.setRun(argv => (sqlHelper(argv) ? {} : answering([['1']], ['n'])(argv)))
  expect(await ws.call('sql', { sql: 'WITH x AS (SELECT 1) SELECT * FROM x', slug: 'y' })).toContain('SQL rules not checked: analysis_sql exited with 0')
  await ws.done()
})

test('lint output without its lists is an error, and the query still runs', async () => {
  const ws = await fake(FILES)
  ws.setRun(argv => (sqlHelper(argv) ? { stdout: '{"ok":true}' } : answering([['1']], ['n'])(argv)))
  const reply = await ws.call('sql', { sql: 'WITH x AS (SELECT 1) SELECT * FROM x', slug: 'x' })
  expect(reply).toContain('SQL rules not checked: analysis_sql printed no errors and warnings')
  expect(reply.startsWith('Query 001: 1 row.')).toBe(true)
  await ws.done()
})

test('an expansion the helper cannot do, or prints wrong, is not run', async () => {
  const ws = await fake(FILES)
  ws.setRun(argv => (sqlHelper(argv) ? { stdout: '', stderr: 'Traceback\nKeyError: x', exitCode: 1 } : {}))
  expect(await ws.call('sql', { sql: 'SELECT {{ a(s) }}', slug: 'x' })).toBe(
    'Not run: the included trusted pieces cannot be used. Fix and send again:\n- The included pieces could not be expanded: Traceback KeyError: x',
  )
  ws.setRun(argv => (sqlHelper(argv) ? { stdout: '{"sql":1}' } : {}))
  expect(await ws.call('sql', { sql: 'SELECT {{ a(s) }}', slug: 'x' })).toBe(
    'Not run: the included trusted pieces cannot be used. Fix and send again:\n- analysis_sql expand printed no expanded SQL',
  )
  expect(await ws.list('queries')).toEqual([])
  await ws.done()
})

test('an expansion that includes nothing adds no built-from or blocks line', async () => {
  const ws = await fake(FILES)
  const expansion = { sql: "SELECT '{{'", lint_sql: "SELECT '{{'", retype_sql: "SELECT '{{'", built_from: [], blocks: [] }
  ws.setRun(argv => {
    if (sqlHelper(argv)) return { stdout: JSON.stringify(argv[3] === 'expand' ? expansion : { warnings: [] }) }
    if (trustHelper(argv)) return { stdout: '{"error":"none"}' }
    return answering([['{{']], ['x'])(argv)
  })
  const reply = await ws.call('sql', { sql: "SELECT '{{'", slug: 'x' })
  expect(reply).toBe('Query 001: 1 row. Columns: x\nx\n{{')
  expect(await ws.file('queries/001_x.sql')).toBe("SELECT '{{'\n")
  expect(await ws.file('queries/001.expanded.sql')).toBe("SELECT '{{'\n")
  await ws.done()
})

// ---------------------------------------------------------------------------
// Steps.

const RUN = { ...FILES, 'queries/042_spend.sql': '-- author: user\nSELECT 1\n' }
const PLAN = (counts: string) => ({
  lineage: { nodes: [], edges: [] },
  steps: [{ k: 1, name: 'final', node: 0, preview: null, counts }],
})
const counted = (columns: string[], rows: string[][]) => ({
  stdout: JSON.stringify([{ state: 'SUCCEEDED', columns, rows }, { state: 'SUCCEEDED', columns: ['1'], rows: [['1']] }]),
})

async function stepsWith(ws: Fake, rows: string[][], columns = ['assay_rows']) {
  ws.setRun(argv => (sqlHelper(argv) ? { stdout: JSON.stringify(PLAN('SELECT 1')) } : counted(columns, rows)))
  expect(await ws.requests.perform({ kind: 'steps', run: 42 })).toEqual({ ok: true })
  return parseSteps((await ws.file('queries/042.steps.json')) ?? '')
}

test('a counts query with no row fails its step', async () => {
  const ws = await fake(RUN)
  const file = await stepsWith(ws, [])
  expect(file?.status).toBe('error')
  expect(file?.steps[0]?.error).toBe('The counts query returned no row.')
  await ws.done()
})

test('an empty row count is no count: the step is ok without rows', async () => {
  const ws = await fake(RUN)
  const file = await stepsWith(ws, [['']])
  expect(file?.steps[0]?.status).toBe('ok')
  expect(file?.steps[0]?.rows).toBeUndefined()
  await ws.done()
})

test('a counts query that throws fails its step with the message', async () => {
  const ws = await fake(RUN)
  ws.setRun(argv => {
    if (sqlHelper(argv)) return { stdout: JSON.stringify(PLAN('SELECT 1')) }
    throw new Error('warehouse gone')
  })
  await ws.requests.perform({ kind: 'steps', run: 42 })
  const file = parseSteps((await ws.file('queries/042.steps.json')) ?? '')
  expect(file?.steps[0]?.error).toBe('warehouse gone')
  await ws.done()
})

test('a plan with a note and joins keeps them in the steps file', async () => {
  const ws = await fake(RUN)
  const joins = [{ j: 1, source: 'b', declared: '1:1', keys: ['id'] }]
  const plan = { ...PLAN('SELECT 1'), note: 'A note.', steps: [{ k: 1, name: 'final', node: 0, preview: null, counts: 'SELECT 1', joins }] }
  ws.setRun(argv => (sqlHelper(argv) ? { stdout: JSON.stringify(plan) } : counted(['assay_rows'], [['3']])))
  await ws.requests.perform({ kind: 'steps', run: 42 })
  const file = parseSteps((await ws.file('queries/042.steps.json')) ?? '')
  expect(file?.note).toBe('A note.')
  expect(file?.steps[0]?.joins).toEqual(joins)
  await ws.done()
})

test('a trusted run with blocks reads its lineage as a template with its blocks', async () => {
  const ws = await fake({ ...FILES, 'queries/042_t.sql': '-- trusted: t\nSELECT 1\n', 'queries/042.expanded.sql': '-- blocks: s=b\nSELECT 1\n' })
  ws.setRun(argv => (sqlHelper(argv) ? { stdout: '{"nodes":[],"edges":[]}' } : {}))
  await ws.requests.perform({ kind: 'lineage', run: 42 })
  expect(ws.runs.find(sqlHelper)?.slice(3)).toEqual(['lineage', 'databricks', '--template', '--blocks', 's=b'])
  await ws.done()
})

// ---------------------------------------------------------------------------
// Trusted calculations.

const LIST = (calculations: object[]) => ({ stdout: JSON.stringify({ calculations }) })
const CALC = { name: 'spend', kind: 'definition', file: 'spend.sql', parameters: [], commit: 'abc', dirty: false }

test('a trusted call naming nothing says there are none, or lists them', async () => {
  const ws = await fake(FILES)
  ws.setRun(() => LIST([]))
  expect(await ws.call('trusted', { name: 'nope' })).toBe('No trusted calculation nope. There are none yet.')
  ws.setRun(() => LIST([CALC]))
  expect(await ws.call('trusted', { name: 'nope' })).toBe('No trusted calculation nope. There are: spend.')
  await ws.done()
})

test("a definition the helper cannot render, or run, says why", async () => {
  const ws = await fake(FILES)
  ws.setRun(argv => (argv[3] === 'list' ? LIST([CALC]) : { stdout: '{"error":"no such table"}' }))
  expect(await ws.call('trusted', { name: 'spend', args: {} })).toBe('no such table spend()')
  ws.setRun(argv => {
    if (argv[3] === 'list') return LIST([CALC])
    if (argv[3] === 'render') return { stdout: '{"sql":"SELECT 1"}' }
    return { stdout: '{"error":"warehouse gone"}' }
  })
  expect(await ws.call('trusted', { name: 'spend', args: {} })).toContain('failed')
  await ws.done()
})

test('the calculations are listed once in 20 s, unless asked fresh', async () => {
  const ws = await fake(FILES)
  ws.setRun(() => LIST([CALC]))
  await ws.assay.calculations()
  await ws.assay.calculations()
  expect(ws.runs.filter(argv => argv[3] === 'list').length).toBe(1)
  await ws.assay.calculations(true)
  expect(ws.runs.filter(argv => argv[3] === 'list').length).toBe(2)
  await ws.done()
})

// ---------------------------------------------------------------------------
// The kernel.

const VENV = { ...FILES, '.venv/bin/python': '' }

test('a serve that ends on its own is dead with its exit; exit 2 is missing; a stop says nothing', async () => {
  const ws = await fake(VENV)
  ws.autoReady = false
  await ws.assay.kernels.start()
  ws.serves[0]?.end(1)
  await until(async () => (await kernelState(ws))?.state === 'dead')
  expect(await kernelState(ws)).toEqual({ state: 'dead', message: 'The kernel process ended (exit 1).' })
  await ws.assay.kernels.start()
  ws.serves[1]?.end(2)
  await until(async () => (await kernelState(ws))?.state === 'missing')
  expect((await kernelState(ws))?.state).toBe('missing')
  await ws.assay.kernels.start()
  ws.serves[2]?.end(null)
  await until(async () => (await kernelState(ws))?.message === 'The kernel process ended.')
  expect(await kernelState(ws)).toEqual({ state: 'dead', message: 'The kernel process ended.' })
  await ws.done()
})

test('a serve that says stopped and ends leaves the kernel as it was', async () => {
  const ws = await fake(VENV)
  await ws.assay.kernels.start()
  await until(async () => (await kernelState(ws))?.state === 'idle')
  ws.serves[0]?.emit({ event: 'stopped' })
  ws.serves[0]?.end(0)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await kernelState(ws)).toEqual({ state: 'idle' })
  await ws.done()
})

test('output from a replaced serve is ignored', async () => {
  const ws = await fake(VENV)
  ws.autoReady = false
  await ws.assay.kernels.start()
  const old = ws.serves[0]
  await ws.assay.kernels.start()
  old?.emit(READY)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect((await kernelState(ws))?.state).toBe('starting')
  await ws.done()
})

test('a kernel that is not running answers interrupt and restart with why', async () => {
  const ws = await fake(FILES)
  expect(await ws.assay.kernels.interrupt()).toBe('No kernel is running.')
  ws.autoReady = false
  const restarting = ws.assay.kernels.restart()
  await until(() => ws.serves.length === 1)
  ws.serves[0]?.emit({ event: 'dead', message: 'no ipykernel' })
  expect(await restarting).toBe('no ipykernel')
  await ws.done()
})

test('an interrupt the kill command refuses says so', async () => {
  const ws = await fake(FILES)
  await ws.assay.kernels.start()
  await until(async () => (await kernelState(ws))?.state === 'idle')
  const proc = ws.assay.config.proc
  const run = proc.run.bind(proc)
  proc.run = (argv, options) => (argv[0] === 'kill' ? Promise.resolve({ exitCode: 1, stdout: '', stderr: '' }) : run(argv, options))
  expect(await ws.assay.kernels.interrupt()).toBe('The kernel could not be interrupted.')
  proc.run = (argv, options) => (argv[0] === 'kill' ? Promise.reject(new Error('no kill')) : run(argv, options))
  expect(await ws.assay.kernels.interrupt()).toBe('no kill')
  await ws.done()
})

test('a runner that fails without a word says how it exited', async () => {
  const ws = await fake(FILES)
  ws.setRun(argv => (argv[1] === RUNNER && argv[2] === 'run' ? { exitCode: 7 } : {}))
  const reply = await ws.call('python', { code: 'print(1)', slug: 'x' })
  expect(reply).toBe('Run 001 failed (saved analyses/feature/queries/001_x.py):\nThe kernel runner exited with 7.')
  await ws.done()
})

test('a run in a kernel already busy keeps it busy when the kernel says ready', async () => {
  const ws = await fake(FILES)
  let release: () => void = () => undefined
  ws.setRun(async argv => {
    if (argv[1] === RUNNER && argv[2] === 'run') {
      await new Promise<void>(resolve => (release = resolve))
      return { stdout: `${JSON.stringify({ status: 'ok', stdout: '', tables: [], plots: [], reads: [] })}\n` }
    }
    return {}
  })
  const running = ws.call('python', { code: 'print(1)', slug: 'x' })
  await until(async () => (await kernelState(ws))?.state === 'busy')
  ws.serves[0]?.emit(READY)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect((await kernelState(ws))?.state).toBe('busy')
  release()
  await running
  await ws.done()
})

test('a serve whose start is overtaken by a newer one is not spawned', async () => {
  const ws = await fake(VENV)
  let answer: () => void = () => undefined
  ws.setRun(argv =>
    argv[1] === '-c'
      ? new Promise(resolve => {
          answer = () => {
            resolve({ exitCode: 0 })
          }
        })
      : {},
  )
  const first = ws.assay.kernels.start()
  await until(() => ws.runs.length === 1)
  const second = ws.assay.kernels.start()
  answer()
  await until(() => ws.runs.length === 2)
  answer()
  await Promise.all([first, second])
  expect(ws.serves.length).toBe(1)
  await ws.done()
})

test('the SQL rules read the statement on stdin', async () => {
  const ws = await fake(FILES)
  const seen: RunOptions[] = []
  ws.setRun((_argv, options) => {
    if (options) seen.push(options)
    return { stdout: '{"errors":[],"warnings":[]}' }
  })
  await ws.call('sql', { sql: 'WITH x AS (SELECT 1) SELECT * FROM x', slug: 'x' })
  expect(seen[0]?.input).toBe('WITH x AS (SELECT 1) SELECT * FROM x')
  await ws.done()
})

test('a kernel that lost its pid cannot take a run', async () => {
  const ws = await fake(FILES)
  await ws.assay.kernels.start()
  await until(async () => (await kernelState(ws))?.state === 'idle')
  if (ws.assay.kernels.current) delete ws.assay.kernels.current.pid
  expect(await ws.call('python', { code: 'print(1)', slug: 'x' })).toBe('The Python kernel is not running: it has no pid.')
  await ws.done()
})

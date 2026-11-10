// The analysis mod's kernel tests (config b2f7df2, claude/analysis/tests/python.test.ts), ported to the server.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { VENV_BUILDING, VENV_MISSING } from '../core/venv.ts'
import { fake, READY, RUNNER, until } from './testing.ts'
import type { Fake, Run } from './testing.ts'

const VENV = { 'analysis.yaml': 'title: Feature\n', '.venv/bin/python': '' }
const ASSAY = { '/opt/venv-assay/bin/python': '' }
const HINT = VENV_MISSING
const printed = (out: object = {}) => ({ stdout: `${JSON.stringify({ status: 'ok', stdout: '', tables: [], plots: [], reads: [], ...out })}\n` })
const isRun = (argv: readonly string[]) => argv[1] === RUNNER && argv[2] === 'run'
const importsIpykernel = (argv: readonly string[]) => argv[1] === '-c' && argv[2] === 'import ipykernel'
const kernelState = async (ws: Fake) => (await ws.status())?.kernel?.state
const project = (ws: Fake) => `${ws.analysis}/.venv/bin/python`

test('a session starts the kernel: serve is spawned with the analysis and a connection file', async () => {
  const ws = await fake(VENV)
  ws.autoReady = false
  await ws.assay.startKernel()
  const [serve] = ws.serves
  expect(serve?.argv.slice(0, 5)).toEqual([project(ws), RUNNER, 'serve', '--analysis', ws.analysis])
  expect(serve?.argv[5]).toBe('--connection')
  expect(serve?.argv[6]).toMatch(/\/tmp\/assay-kernel-\d+-[a-z0-9]+\.json$/)
  expect((await ws.status())?.kernel).toEqual({ state: 'starting' })
  serve?.emit(READY)
  await until(async () => (await kernelState(ws)) === 'idle')
  expect(await ws.status()).toEqual({ running: null, failed: {}, kernel: { state: 'idle' } })
  expect(JSON.parse((await ws.file('.assay/session.json')) ?? '{}')).toEqual({ python: project(ws) })
  await ws.done()
})

test('the serve process is stopped when the session ends', async () => {
  const ws = await fake(VENV)
  await ws.assay.startKernel()
  ws.assay.stopKernel()
  expect(ws.serves[0]?.isStopped).toBe(true)
  await ws.done()
})

test('neither a project .venv nor venv-assay: the kernel is missing with the hint, and the python tool says what to do', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n' })
  await ws.assay.startKernel()
  expect((await ws.status())?.kernel).toEqual({ state: 'missing', message: HINT })
  expect(await ws.call('python', { code: 'print(1)', slug: 'x' })).toBe(`The Python kernel is not available: ${HINT}`)
  expect(await ws.list('queries')).toEqual([])
  expect(ws.serves).toEqual([])
  expect(JSON.parse((await ws.file('.assay/session.json')) ?? '{}')).toEqual({ python: null })
  await ws.done()
})

test("while the app builds Assay's venv, the python and trusted tools say it is still building", async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay.status.json': '{"state":"building"}' })
  await ws.assay.startKernel()
  expect((await ws.status())?.kernel).toEqual({ state: 'missing', message: VENV_BUILDING })
  expect(await ws.call('python', { code: '1', slug: 'x' })).toBe(`The Python kernel is not available: ${VENV_BUILDING}`)
  expect(await ws.call('trusted', { name: 'nope' })).toBe(`Cannot list the trusted calculations: ${VENV_BUILDING}`)
  await ws.done()
})

test("a failed build of Assay's venv: the tools return the build's error", async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay.status.json': '{"state":"failed","error":"uv: no network"}' })
  await ws.assay.startKernel()
  expect(await ws.call('python', { code: '1', slug: 'x' })).toBe("The Python kernel is not available: Assay could not build its Python environment: uv: no network")
  await ws.done()
})

test('once the venv is built, the next python call starts the kernel with it', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay.status.json': '{"state":"building"}' })
  await ws.assay.startKernel()
  await ws.put('/opt/venv-assay/bin/python', '')
  await ws.put('/opt/venv-assay.status.json', '{"state":"ready"}')
  ws.setRun(argv => (isRun(argv) ? printed({ stdout: '1\n' }) : {}))
  expect(await ws.call('python', { code: 'print(1)', slug: 'x' })).toMatch(/^Run 001: ok/)
  expect(ws.serves[0]?.argv[0]).toBe(`${ws.venv}/bin/python`)
  await ws.done()
})

test("a project .venv that imports ipykernel runs the kernel, with Assay's own runner", async () => {
  const ws = await fake({ ...VENV, ...ASSAY })
  const checks: (readonly string[])[] = []
  ws.setRun(argv => {
    if (importsIpykernel(argv)) checks.push(argv)
    return {}
  })
  await ws.assay.startKernel()
  expect(ws.serves[0]?.argv.slice(0, 2)).toEqual([project(ws), RUNNER])
  expect(checks).toEqual([[project(ws), '-c', 'import ipykernel']])
  await ws.done()
})

test('a project .venv that cannot import ipykernel falls back to venv-assay', async () => {
  const ws = await fake({ ...VENV, ...ASSAY })
  ws.setRun(argv => (importsIpykernel(argv) ? { exitCode: 1, stderr: 'ModuleNotFoundError' } : {}))
  await ws.assay.startKernel()
  expect(ws.serves[0]?.argv.slice(0, 2)).toEqual([`${ws.venv}/bin/python`, RUNNER])
  await ws.done()
})

test('a project .venv whose import check fails to run falls back too', async () => {
  const ws = await fake({ ...VENV, ...ASSAY })
  ws.setRun(argv => {
    if (importsIpykernel(argv)) throw new Error('spawn failed')
    return {}
  })
  await ws.assay.startKernel()
  expect(ws.serves[0]?.argv[0]).toBe(`${ws.venv}/bin/python`)
  await ws.done()
})

test('no project .venv: venv-assay runs the kernel, and no import check runs', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', ...ASSAY })
  await ws.assay.startKernel()
  expect(ws.serves[0]?.argv.slice(0, 2)).toEqual([`${ws.venv}/bin/python`, RUNNER])
  expect(ws.runs.some(importsIpykernel)).toBe(false)
  await ws.done()
})

test('a project .venv without ipykernel and no venv-assay: missing with the hint', async () => {
  const ws = await fake(VENV)
  ws.setRun(argv => (importsIpykernel(argv) ? { exitCode: 1 } : {}))
  await ws.assay.startKernel()
  expect((await ws.status())?.kernel).toEqual({ state: 'missing', message: HINT })
  expect(ws.serves).toEqual([])
  await ws.done()
})

test('ipykernel missing, said by the runner, is the missing state with its message', async () => {
  const ws = await fake(VENV)
  ws.autoReady = false
  await ws.assay.startKernel()
  const said = "ipykernel is not installed in this Python. Assay's venv has it: open Settings and see the Doctor."
  ws.serves[0]?.emit({ event: 'missing', message: said })
  await until(async () => (await kernelState(ws)) === 'missing')
  expect((await ws.status())?.kernel).toEqual({ state: 'missing', message: said })
  ws.serves[0]?.end(2)
  // A call tries a new kernel; it says the same again.
  const call = ws.call('python', { code: '1', slug: 'x' })
  await until(() => ws.serves.length === 2)
  ws.serves[1]?.emit({ event: 'missing', message: said })
  expect(await call).toContain('ipykernel is not installed')
  await ws.done()
})

test('the python tool saves the .py, runs it in the kernel and replies with the run', async () => {
  const ws = await fake({ ...VENV, 'queries/002_old.sql': 'SELECT 2\n' })
  const seen: unknown[] = []
  const run: Run = async argv => {
    if (!isRun(argv)) return {}
    seen.push(await ws.status())
    return printed({
      stdout: 'hello\n',
      tables: [{ file: '003_stats.t1.csv', columns: ['a', 'b'], rows: [['1', 'x']], rowCount: 1, truncated: false }],
      plots: ['003_stats.p1.png'],
    })
  }
  ws.setRun(run)
  await ws.assay.startKernel()
  const reply = await ws.call('python', { code: '  print("hello")  ', slug: 'Stats!' })
  expect(await ws.file('queries/003_stats.py')).toBe('print("hello")\n')
  expect(reply).toBe('Run 003: ok (0.0 s).\nhello\nTable 1 (analyses/feature/queries/003_stats.t1.csv): 1 row. Columns: a, b\na  b\n1  x\nPlot: analyses/feature/queries/003_stats.p1.png (Read it to check the chart.)')
  const command = ws.runs.find(isRun) ?? []
  expect(command.slice(0, 4)).toEqual([project(ws), RUNNER, 'run', '--connection'])
  expect(command[4]).toMatch(/assay-kernel-.*\.json$/)
  expect(command.slice(5)).toEqual(['--analysis', ws.analysis, '--code-file', 'queries/003_stats.py', '--timeout', '590', '--serve-pid', '4242'])
  // While it ran: the run was named and the kernel busy; afterwards neither.
  expect(seen[0]).toMatchObject({ running: { number: 3 }, kernel: { state: 'busy' } })
  expect(await ws.status()).toEqual({ running: null, failed: {}, kernel: { state: 'idle' } })
  await ws.done()
})

test('Python and SQL runs share one number sequence', async () => {
  const ws = await fake(VENV)
  ws.setRun(argv => (isRun(argv) ? printed() : { stdout: JSON.stringify([{ state: 'SUCCEEDED', columns: ['n'], rows: [['1']] }, { state: 'SUCCEEDED', columns: ['1'], rows: [['1']] }]) }))
  await ws.assay.startKernel()
  expect(await ws.call('sql', { sql: 'SELECT 1', slug: 'a' })).toMatch(/^Query 001/)
  expect(await ws.call('python', { code: '1', slug: 'b' })).toMatch(/^Run 002/)
  expect(await ws.call('sql', { sql: 'SELECT 1', slug: 'c' })).toMatch(/^Query 003/)
  await ws.done()
})

test('an error run and an empty call', async () => {
  const ws = await fake(VENV)
  ws.setRun(argv => (isRun(argv) ? printed({ status: 'error', error: { name: 'KeyError', message: "'x'", traceback: "Traceback\nKeyError: 'x'" } }) : {}))
  await ws.assay.startKernel()
  expect(await ws.call('python', { code: 'd["x"]', slug: 'boom' })).toBe("Run 001: error (0.0 s).\nTraceback\nKeyError: 'x'")
  expect(await ws.call('python', { code: '  ', slug: 'none' })).toBe('Give the Python code to run.')
  expect(await ws.file('queries/002_none.py')).toBeUndefined()
  await ws.done()
})

test('a runner that cannot reach the kernel is a failed run, recorded in runs.json', async () => {
  const ws = await fake(VENV)
  ws.setRun(argv => (isRun(argv) ? { exitCode: 2, stderr: 'no connection file\n' } : {}))
  await ws.assay.startKernel()
  expect(await ws.call('python', { code: '1', slug: 'x' })).toBe('Run 001 failed (saved analyses/feature/queries/001_x.py):\nno connection file')
  expect((await ws.status())?.failed).toEqual({ '1': 'no connection file' })
  await ws.done()
})

test('runs go one at a time, in arrival order', async () => {
  const ws = await fake(VENV)
  let active = 0
  let most = 0
  const order: string[] = []
  ws.setRun(async argv => {
    if (!isRun(argv)) return {}
    order.push(argv[argv.indexOf('--code-file') + 1] ?? '')
    active++
    most = Math.max(most, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return printed()
  })
  await ws.assay.startKernel()
  const replies = await Promise.all(['a', 'b', 'c'].map(slug => ws.call('python', { code: '1', slug })))
  expect(replies.map(reply => reply.slice(0, 7))).toEqual(['Run 001', 'Run 002', 'Run 003'])
  expect(most).toBe(1)
  expect(order).toEqual(['queries/001_a.py', 'queries/002_b.py', 'queries/003_c.py'])
  await ws.done()
})

test('a dead kernel is started again on the next run, with a note', async () => {
  const ws = await fake(VENV)
  ws.setRun(argv => (isRun(argv) ? printed() : {}))
  await ws.assay.startKernel()
  await until(async () => (await kernelState(ws)) === 'idle')
  ws.serves[0]?.emit({ event: 'dead', message: 'The kernel died' })
  await until(async () => (await kernelState(ws)) === 'dead')
  expect((await ws.status())?.kernel).toEqual({ state: 'dead', message: 'The kernel died' })
  ws.serves[0]?.end(1)
  expect(await ws.call('python', { code: '1', slug: 'again' })).toBe('The kernel had died: this run is in a new kernel, so earlier variables are gone.\nRun 001: ok (0.0 s).')
  expect(ws.serves).toHaveLength(2)
  await ws.done()
})

test('a serve process that ends by itself is a dead kernel with what it printed', async () => {
  const ws = await fake(VENV)
  await ws.assay.startKernel()
  await until(async () => (await kernelState(ws)) === 'idle')
  ws.serves[0]?.print('Traceback\nImportError: nope\n', 'stderr')
  ws.serves[0]?.end(1)
  await until(async () => (await kernelState(ws)) === 'dead')
  expect((await ws.status())?.kernel).toEqual({ state: 'dead', message: 'Traceback ImportError: nope' })
  await ws.done()
})

test('the runner time is the one shown, and exit 3 (kernel unreachable) marks the kernel dead', async () => {
  const ws = await fake(VENV)
  ws.setRun(argv => (isRun(argv) ? printed({ durationMs: 2300 }) : {}))
  await ws.assay.startKernel()
  expect(await ws.call('python', { code: '1', slug: 'a' })).toBe('Run 001: ok (2.3 s).')
  ws.setRun(argv => (isRun(argv) ? { exitCode: 3, ...printed({ status: 'error', error: { name: 'KernelUnreachable', message: 'No kernel answers', traceback: '' } }) } : {}))
  expect(await ws.call('python', { code: '1', slug: 'b' })).toBe('Run 002: error (0.0 s).\nKernelUnreachable: No kernel answers')
  expect((await ws.status())?.kernel).toEqual({ state: 'dead', message: 'No kernel answers' })
  await ws.done()
})

test('a ready without a pid means no run: the reply says the kernel is not running, and nothing is run', async () => {
  const ws = await fake(VENV)
  ws.autoReady = false
  ws.setRun(argv => (isRun(argv) ? printed() : {}))
  await ws.assay.startKernel()
  ws.serves[0]?.emit({ event: 'ready', kernel: 'k1', pid: 0 })
  await until(async () => (await kernelState(ws)) === 'idle')
  expect(await ws.call('python', { code: '1', slug: 'x' })).toBe('The Python kernel is not running: it has no pid.')
  expect(ws.runs.some(isRun)).toBe(false)
  await ws.done()
})

test('a serve that never says ready is stopped and the kernel is dead', async () => {
  const ws = await fake(VENV)
  ws.autoReady = false
  await ws.assay.startKernel()
  await ws.assay.kernelSettled(50)
  expect(ws.serves[0]?.isStopped).toBe(true)
  expect((await ws.status())?.kernel).toEqual({ state: 'dead', message: 'The kernel did not start within 0.05 s.' })
  await ws.done()
})

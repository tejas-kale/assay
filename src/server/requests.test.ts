// The analysis mod's request tests (config b2f7df2, claude/analysis/tests/requests.test.ts and
// python-requests.test.ts), ported: `.assay/requests/<id>.json` in, `.assay/replies/<id>.json` out. A poll is
// called directly where the mod's tests advanced the clock.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { answering, fake, READY, until } from './testing.ts'
import type { Fake } from './testing.ts'

const ID = '1760000000000-abc123'
const SECOND = '1760000000001-bbbbbb'
const requestPath = (id = ID) => `.assay/requests/${id}.json`
const reply = async (ws: Fake, id = ID) => JSON.parse((await ws.file(`.assay/replies/${id}.json`)) ?? 'null')
const hasReply = async (ws: Fake, id = ID) => (await ws.file(`.assay/replies/${id}.json`)) !== undefined
const isRun = (argv: readonly string[]) => argv[2] === 'run'
const printed = (status = 'ok') => ({ stdout: `${JSON.stringify({ status, stdout: '', tables: [], plots: [], reads: [] })}\n` })
const codeFile = (argv: readonly string[]) => argv[argv.indexOf('--code-file') + 1]
const userRuns = async (ws: Fake) => JSON.parse((await ws.file('.assay/user-runs.json')) ?? '[]')

async function sqlSession(files: Record<string, string> = {}) {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', 'queries/002_old.sql': 'SELECT 2\n', ...files })
  ws.setRun(answering([['1']], ['n']))
  return ws
}

/** A session whose kernel is up, with a project .venv. */
async function pythonSession(files: Record<string, string> = {}) {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', '.venv/bin/python': '', ...files })
  ws.setRun(argv => (isRun(argv) ? printed() : {}))
  await ws.assay.kernels.start()
  await until(async () => (await ws.status())?.kernel?.state === 'idle')
  return ws
}

/** Puts a request in and lets a poll take it (not waiting for it to finish). */
async function send(ws: Fake, body: unknown, id = ID) {
  await ws.put(requestPath(id), typeof body === 'string' ? body : JSON.stringify(body))
  void ws.requests.poll()
}

test('a request makes the next run with its header lines, and a reply names its number', async () => {
  const ws = await sqlSession()
  await send(ws, { id: ID, kind: 'sql', sql: '  SELECT 1  ', engine: 'databricks', from: 2, slug: 'My Old Query' })
  await until(() => hasReply(ws))
  expect(await ws.file('queries/003_my-old-query.sql')).toBe('-- author: user\n-- from: 002\nSELECT 1\n')
  expect(await ws.file('queries/003_my-old-query.csv')).toBe('n\n1\n')
  expect(await reply(ws)).toEqual({ id: ID, number: 3 })
  expect(await ws.file(requestPath())).toBeUndefined()
  expect(await userRuns(ws)).toEqual([{ number: 3, language: 'sql', from: 2 }])
  await ws.done()
})

test('a request with no origin is saved as query, with author only', async () => {
  const ws = await sqlSession()
  await send(ws, { id: ID, kind: 'sql', sql: 'SELECT 1', engine: 'databricks' })
  await until(() => hasReply(ws))
  expect(await ws.file('queries/003_query.sql')).toBe('-- author: user\nSELECT 1\n')
  await ws.done()
})

test('Postgres keeps its mark after the user headers', async () => {
  const ws = await sqlSession()
  await send(ws, { id: ID, kind: 'sql', sql: 'SELECT 1', engine: 'postgres', from: 1, slug: 'pg' })
  await until(() => hasReply(ws))
  expect(await ws.file('queries/003_pg.sql')).toBe('-- author: user\n-- from: 001\n-- postgres\nSELECT 1\n')
  expect(ws.runs.at(-1)?.[0]).toBe('rds-psql')
  await ws.done()
})

test('a failed run still gets a reply with its number', async () => {
  const ws = await sqlSession()
  ws.setRun(() => ({ stdout: 'not json', exitCode: 1, stderr: 'boom' }))
  await send(ws, { id: ID, kind: 'sql', sql: 'SELECT nope', engine: 'databricks' })
  await until(() => hasReply(ws))
  expect(await reply(ws)).toEqual({ id: ID, number: 3 })
  expect(await ws.file('queries/003_query.csv')).toBeUndefined()
  await ws.done()
})

for (const [label, text] of [
  ['unreadable JSON', '{nope'],
  ['an unknown kind', JSON.stringify({ id: ID, kind: 'nope', sql: 'x', engine: 'databricks' })],
  ['empty SQL', JSON.stringify({ id: ID, kind: 'sql', sql: '  ', engine: 'databricks' })],
] as const) {
  test(`${label} is refused with an error reply, no run, and the request is gone`, async () => {
    const ws = await sqlSession()
    await send(ws, text)
    await until(() => hasReply(ws))
    expect(typeof (await reply(ws)).error).toBe('string')
    expect((await reply(ws)).number).toBeUndefined()
    expect(await ws.list('queries')).toEqual(['queries/002_old.sql'])
    expect(await ws.file(requestPath())).toBeUndefined()
    await ws.done()
  })
}

test('requests run in name order, one after the other', async () => {
  const ws = await sqlSession()
  await ws.put(requestPath('1760000000002-bbbbbb'), JSON.stringify({ kind: 'sql', sql: 'SELECT 2', engine: 'databricks', slug: 'second' }))
  await ws.put(requestPath('1760000000001-aaaaaa'), JSON.stringify({ kind: 'sql', sql: 'SELECT 1', engine: 'databricks', slug: 'first' }))
  await ws.requests.poll()
  expect(await ws.file('queries/003_first.sql')).toBeDefined()
  expect(await ws.file('queries/004_second.sql')).toBeDefined()
  await ws.done()
})

test('dot-files and names not ending in .json are ignored', async () => {
  const body = JSON.stringify({ id: ID, kind: 'sql', sql: 'SELECT 1', engine: 'databricks' })
  const ws = await sqlSession({ '.assay/requests/.tmp.json': body, '.assay/requests/note.txt': body, [`.assay/requests/.${ID}.json.tmp`]: body })
  await ws.requests.poll()
  await ws.requests.poll()
  expect(await ws.list('queries')).toEqual(['queries/002_old.sql'])
  expect(await ws.file('.assay/requests/.tmp.json')).toBe(body)
  await ws.done()
})

test('the server polls every 500 ms once started', async () => {
  const ws = await sqlSession()
  ws.requests.start()
  await ws.put(requestPath(), JSON.stringify({ kind: 'sql', sql: 'SELECT 1', engine: 'databricks' }))
  expect(await until(() => hasReply(ws))).toBe(true)
  ws.requests.stop()
  await ws.done()
})

test("a python request is saved as the user's, with its origin, and the reply names its number", async () => {
  const ws = await pythonSession({ 'queries/002_old.py': 'x = 1\n' })
  await send(ws, { id: ID, kind: 'python', code: '  print(x)  ', from: 2, slug: 'My Old' })
  await until(() => hasReply(ws))
  expect(await ws.file('queries/003_my-old.py')).toBe('# author: user\n# from: 002\nprint(x)\n')
  expect(await reply(ws)).toEqual({ id: ID, number: 3 })
  expect(await ws.file(requestPath())).toBeUndefined()
  expect(ws.runs.find(isRun)?.includes('queries/003_my-old.py')).toBe(true)
  expect(await userRuns(ws)).toEqual([{ number: 3, language: 'python', from: 2 }])
  await ws.done()
})

test('a python request with no origin has the author line only, and slug query', async () => {
  const ws = await pythonSession()
  await send(ws, { id: ID, kind: 'python', code: '1' })
  await until(() => hasReply(ws))
  expect(await ws.file('queries/001_query.py')).toBe('# author: user\n1\n')
  await ws.done()
})

test('empty code and a bad replay are refused, with no run', async () => {
  const ws = await pythonSession()
  await send(ws, { id: ID, kind: 'python', code: ' ' })
  await until(() => hasReply(ws))
  expect(await reply(ws)).toEqual({ id: ID, error: 'The code is empty.' })
  await send(ws, { kind: 'replay', runs: [] }, SECOND)
  await until(() => hasReply(ws, SECOND))
  expect(typeof (await reply(ws, SECOND)).error).toBe('string')
  expect(await ws.list('queries')).toEqual([])
  await ws.done()
})

test('interrupt is taken while a run is in progress: SIGUSR1 to the serve pid, then ok', async () => {
  const ws = await pythonSession()
  let release: () => void = () => undefined
  ws.setRun(async argv => {
    if (!isRun(argv)) return {}
    await new Promise<void>(resolve => (release = resolve))
    return printed('interrupted')
  })
  await send(ws, { id: ID, kind: 'python', code: 'import time; time.sleep(99)', slug: 'slow' })
  await until(() => ws.runs.some(isRun))
  await send(ws, { kind: 'interrupt' }, SECOND)
  await until(() => hasReply(ws, SECOND))
  expect(ws.runs).toContainEqual(['kill', '-USR1', String(READY.pid)])
  expect(await reply(ws, SECOND)).toEqual({ id: SECOND, ok: true })
  expect(await hasReply(ws)).toBe(false)
  release()
  await until(() => hasReply(ws))
  expect(await reply(ws)).toEqual({ id: ID, number: 1 })
  await ws.done()
})

test('restart is taken while a run is in progress: a new serve process starts', async () => {
  const ws = await pythonSession()
  let release: () => void = () => undefined
  ws.setRun(async argv => {
    if (!isRun(argv)) return {}
    await new Promise<void>(resolve => (release = resolve))
    return printed('error')
  })
  await send(ws, { id: ID, kind: 'python', code: '1', slug: 'slow' })
  await until(() => ws.runs.some(isRun))
  await send(ws, { kind: 'restart' }, SECOND)
  await until(() => hasReply(ws, SECOND))
  expect(ws.serves).toHaveLength(2)
  expect(ws.serves[1]?.argv[2]).toBe('serve')
  expect(ws.serves[0]?.isStopped).toBe(true)
  expect(await reply(ws, SECOND)).toEqual({ id: SECOND, ok: true })
  release()
  await until(() => hasReply(ws))
  await ws.done()
})

test('a restart during a run: the new kernel is idle, and the old run ending does not change it', async () => {
  const ws = await pythonSession()
  let release: () => void = () => undefined
  ws.setRun(async argv => {
    if (!isRun(argv)) return {}
    await new Promise<void>(resolve => (release = resolve))
    return printed()
  })
  const state = async () => (await ws.status())?.kernel?.state
  await send(ws, { id: ID, kind: 'python', code: '1', slug: 'slow' })
  await until(async () => (await state()) === 'busy')
  await send(ws, { kind: 'restart' }, SECOND)
  await until(() => hasReply(ws, SECOND))
  expect(await state()).toBe('idle')
  release()
  await until(() => hasReply(ws))
  expect(await state()).toBe('idle')
  await ws.done()
})

test("replay restarts the kernel and runs each run again as the user's, in order", async () => {
  const ws = await pythonSession({ 'queries/001_load.py': 'df = 1\n', 'queries/002_q.sql': 'SELECT 1\n', 'queries/003_use.py': '# author: user\n# from: 001\nprint(df)\n' })
  await send(ws, { id: ID, kind: 'replay', runs: [1, 3] })
  await until(() => hasReply(ws))
  expect(await reply(ws)).toEqual({ id: ID, ok: true })
  expect(ws.serves).toHaveLength(2)
  expect(await ws.file('queries/004_load.py')).toBe('# author: user\n# replay: 001\ndf = 1\n')
  expect(await ws.file('queries/005_use.py')).toBe('# author: user\n# replay: 003\nprint(df)\n')
  expect(ws.runs.filter(isRun).map(codeFile)).toEqual(['queries/004_load.py', 'queries/005_use.py'])
  expect(await userRuns(ws)).toEqual([
    { number: 4, language: 'python', replay: 1 },
    { number: 5, language: 'python', replay: 3 },
  ])
  await ws.done()
})

test('replay stops at the first run that is not ok', async () => {
  const ws = await pythonSession({ 'queries/001_a.py': '1\n', 'queries/002_b.py': 'boom\n', 'queries/003_c.py': '3\n' })
  ws.setRun(argv => (isRun(argv) ? printed(codeFile(argv) === 'queries/005_b.py' ? 'error' : 'ok') : {}))
  await send(ws, { id: ID, kind: 'replay', runs: [1, 2, 3] })
  await until(() => hasReply(ws))
  expect(await reply(ws)).toEqual({ id: ID, error: 'Replay stopped at run 005 (replay of 002): error' })
  expect(await ws.file('queries/006_c.py')).toBeUndefined()
  await ws.done()
})

test('a replay naming a SQL run or an unknown number refuses, and nothing runs or restarts', async () => {
  const ws = await pythonSession({ 'queries/001_a.py': '1\n', 'queries/002_q.sql': 'SELECT 1\n' })
  await send(ws, { id: ID, kind: 'replay', runs: [1, 2] })
  await until(() => hasReply(ws))
  expect(await reply(ws)).toEqual({ id: ID, error: 'Run 002 is not a Python run.' })
  await send(ws, { kind: 'replay', runs: [9] }, SECOND)
  await until(() => hasReply(ws, SECOND))
  expect((await reply(ws, SECOND)).error).toBe('Run 009 is not a Python run.')
  expect(ws.serves).toHaveLength(1)
  expect(ws.runs.some(isRun)).toBe(false)
  await ws.done()
})

test("Claude's runs are not the user's: nothing is recorded for the prompt's notice", async () => {
  const ws = await pythonSession()
  await ws.call('python', { code: '1', slug: 'mine' })
  await ws.call('sql', { sql: 'SELECT 1', slug: 'mine' })
  expect(await ws.file('.assay/user-runs.json')).toBeUndefined()
  await ws.done()
})

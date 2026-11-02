// The bundled server end to end: the SDK's MCP client over stdio starts out/server/index.mjs (built into a temp
// folder) on a scratch analysis, with a stub `databricks` on PATH. With ASSAY_TEST_VENV naming a venv that has
// ipykernel and the helpers (python/tests/test_venv.sh builds one), the kernel is real; without it the Python tools
// must say venv-assay is not built.
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { VENV_ASSAY_HINT } from '../core/rules.ts'
import { bundle } from '../testing/bundle.ts'
import { expect } from '../testing/expect.ts'
import { until } from './testing.ts'

const VENV = process.env.ASSAY_TEST_VENV

/** A Databricks CLI that answers every query with one row. */
const STUB = `#!/bin/sh
echo '[{"state":"SUCCEEDED","columns":["n"],"rows":[["1"]]},{"state":"SUCCEEDED","columns":["1"],"rows":[["1"]]}]'
`

async function session() {
  const dir = await mkdtemp(join(tmpdir(), 'assay-mcp-'))
  const root = join(dir, 'notes-src')
  const analysis = join(root, 'analyses/panel')
  await mkdir(join(dir, 'bin'), { recursive: true })
  await mkdir(analysis, { recursive: true })
  await writeFile(join(dir, 'bin/databricks'), STUB)
  await chmod(join(dir, 'bin/databricks'), 0o755)
  await writeFile(join(analysis, '.analysis'), '')
  await writeFile(join(analysis, 'notes.md'), 'old fact [q 001]\n')
  const out = await bundle()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(out, 'server/index.mjs')],
    cwd: analysis,
    stderr: 'pipe',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      HOME: dir,
      TMPDIR: dir,
      ASSAY_ANALYSIS: analysis,
      ASSAY_ROOT: root,
      ASSAY_VENV: VENV ?? join(dir, 'no-venv'),
      ASSAY_KERNEL_RUNNER: resolve('python/analysis_kernel.py'),
    },
  })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return ((result.content as { type: string; text: string }[])[0]?.text ?? '') as string
  }
  const file = (path: string) => readFile(join(analysis, path), 'utf8').catch(() => undefined)
  const kernel = async () => JSON.parse((await file('.assay/runs.json')) ?? '{}')?.kernel?.state as string | undefined
  return { dir, root, analysis, client, call, file, kernel, close: () => client.close() }
}

test('the bundled server lists its tools and answers each once', { timeout: 120_000 }, async () => {
  const s = await session()
  const { tools } = await s.client.listTools()
  expect(tools.map(tool => tool.name)).toEqual(['sql', 'python', 'trusted', 'park', 'close', 'focus', 'order', 'note', 'revise_note', 'link_note', 'new_note'])
  // On start: the files set up and the old fact labelled.
  expect(await s.file('threads.md')).toBe('## Open\n\n## Closed\n')
  expect(await s.file('notes.md')).toBe('old fact [unverified q 001]\n')

  expect(await s.call('sql', { sql: 'SELECT 1 AS n', slug: 'one' })).toBe('Query 001: 1 row. Columns: n\nn\n1')
  expect(await s.file('queries/001_one.csv')).toBe('n\n1\n')
  if (VENV) {
    expect(await until(async () => (await s.kernel()) === 'idle', 60_000)).toBe(true)
    expect(await s.call('python', { code: 'x = q(1)\nprint(int(x.n[0]) + 41)', slug: 'answer' })).toMatch(/^Run 002: ok \(\d+\.\d s\)\.\n42$/)
    expect(await s.call('trusted', { name: 'nope' })).toBe('No trusted calculation nope. There are none yet.')
  } else {
    expect(await until(async () => (await s.kernel()) === 'missing')).toBe(true)
    expect(await s.call('python', { code: '1', slug: 'x' })).toBe(`The Python kernel is not available: ${VENV_ASSAY_HINT}`)
    expect(await s.call('trusted', { name: 'nope' })).toBe(`Cannot list the trusted calculations: ${VENV_ASSAY_HINT}`)
  }
  expect(await s.call('park', { thread: 'Why is n 1?' })).toBe('Parked. 1 open thread.')
  expect(await s.call('park', { thread: 'Is it per site?' })).toBe('Parked. 2 open threads.')
  expect(await s.call('focus', { thread: '2' })).toBe('Focused: 1. Is it per site?')
  expect(await s.call('order', { threads: ['2'] })).toBe('Open threads now:\n1. Why is n 1?\n2. Is it per site?')
  expect(await s.call('close', { thread: '1', outcome: 'stub' })).toBe('Closed "Why is n 1?". Next open thread: 1. Is it per site?')
  expect(await s.call('note', { text: 'n is 1', query: 1 })).toBe('Noted as queried q 001.')
  expect(await s.call('revise_note', { note: '1', query: 1 })).toBe('Note 1 is now queried q 001.')
  expect(await s.call('new_note', { title: 'One', slug: 'one', text: 'It is 1 [q 1].' })).toBe('Wrote notes/001-one.md. Link it from other notes with [[one]].')
  await writeFile(join(s.dir, 'wiki.md'), '# Wiki page\n')
  expect(await s.call('link_note', { path: join(s.dir, 'wiki.md') })).toBe(`Listed "Wiki page" in notes.md; the app's Notes tab shows it.`)
  await s.close()
})

test('without ASSAY_ANALYSIS every tool says Assay did not start the session', { timeout: 60_000 }, async () => {
  const out = await bundle()
  const dir = await mkdtemp(join(tmpdir(), 'assay-mcp-'))
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(out, 'server/index.mjs')], cwd: dir, env: { PATH: process.env.PATH ?? '' } }))
  const result = await client.callTool({ name: 'sql', arguments: { sql: 'SELECT 1', slug: 'x' } })
  expect((result.content as { text: string }[])[0]?.text).toBe('Assay did not start this session: there is no analysis to work in. Open the analysis in the Assay app.')
  await client.close()
})

test('each request type through the files, including the trust ones and an answer outside asking', { timeout: 180_000 }, async () => {
  const s = await session()
  await mkdir(join(s.analysis, 'lib/trusted'), { recursive: true })
  await writeFile(join(s.analysis, 'lib/trusted/ones.sql'), '/*---\ndescription: Ones.\nparameters: {}\n---*/\nSELECT 1 AS n\n')
  let n = 0
  const ask = async (body: object) => {
    const id = `17600000000${String(++n).padStart(2, '0')}-aaaaaa`
    await mkdir(join(s.analysis, '.assay/requests'), { recursive: true })
    await writeFile(join(s.analysis, `.assay/requests/.${id}.tmp`), JSON.stringify({ id, ...body }))
    const { rename } = await import('node:fs/promises')
    await rename(join(s.analysis, `.assay/requests/.${id}.tmp`), join(s.analysis, `.assay/requests/${id}.json`))
    expect(await until(async () => (await s.file(`.assay/replies/${id}.json`)) !== undefined, 120_000)).toBe(true)
    return JSON.parse((await s.file(`.assay/replies/${id}.json`)) ?? '{}')
  }
  expect(await ask({ kind: 'sql', sql: 'SELECT 1 AS n', engine: 'databricks', slug: 'mine' })).toMatchObject({ number: 1 })
  expect(await s.file('queries/001_mine.sql')).toBe('-- author: user\nSELECT 1 AS n\n')
  if (VENV) {
    await until(async () => (await s.kernel()) === 'idle', 60_000)
    expect(await ask({ kind: 'python', code: 'y = 2', slug: 'py' })).toMatchObject({ number: 2 })
    expect(await ask({ kind: 'interrupt' })).toMatchObject({ ok: true })
    expect(await ask({ kind: 'restart' })).toMatchObject({ ok: true })
    expect(await ask({ kind: 'replay', runs: [2] })).toMatchObject({ ok: true })
    expect(await s.file('queries/003_py.py')).toBe('# author: user\n# replay: 002\ny = 2\n')
  } else {
    expect(await ask({ kind: 'python', code: 'y = 2', slug: 'py' })).toEqual({ id: expect_id(n), error: `The Python kernel is not available: ${VENV_ASSAY_HINT}` })
    expect((await ask({ kind: 'interrupt' })).error).toBe('No kernel is running.')
    expect((await ask({ kind: 'restart' })).error).toBe(VENV_ASSAY_HINT)
    expect((await ask({ kind: 'replay', runs: [1] })).error).toBe('Run 001 is not a Python run.')
  }
  expect(await ask({ kind: 'trust-list' })).toMatchObject({ proposals: [{ name: 'ones', kind: 'calculation', folder: 'lib/trusted' }] })
  expect(await ask({ kind: 'trust-answer', name: 'ones', answer: 'trust' })).toMatchObject({ error: 'No review of ones is waiting for an answer.' })
  expect(await ask({ kind: 'trust-check', name: 'ones' })).toMatchObject({ ok: true })
  // The real helper checks it (with a venv) or cannot (without): either way the review ends, written to the trust file.
  const review = async () => JSON.parse((await s.file('.assay/trust/ones.json')) ?? '{}')
  expect(await until(async () => ['asking', 'failed', 'error'].includes((await review()).state), 120_000)).toBe(true)
  if ((await review()).state !== 'asking') expect(await ask({ kind: 'trust-answer', name: 'ones', answer: 'trust' })).toMatchObject({ error: 'No review of ones is waiting for an answer.' })
  // Nothing reached the shared trusted/ folder.
  expect(await readFile(join(s.root, 'trusted/ones.sql'), 'utf8').catch(() => undefined)).toBeUndefined()
  // The user's runs, for the next prompt's notice.
  expect(JSON.parse((await s.file('.assay/user-runs.json')) ?? '[]')[0]).toEqual({ number: 1, language: 'sql' })
  await s.close()
})

const expect_id = (n: number) => `17600000000${String(n).padStart(2, '0')}-aaaaaa`

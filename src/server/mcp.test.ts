// The bundled server end to end: the SDK's MCP client over stdio starts out/server/index.mjs (built into a temp
// folder) on a scratch analysis, with a stub `databricks` on PATH and no venv, so the Python tools must say Assay's
// venv is not built. The real kernel runs in tests/integration/backend.test.ts.
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { VENV_MISSING as VENV_ASSAY_HINT } from '../core/venv.ts'
import { bundle } from '../testing/bundle.ts'
import { expect } from '../testing/expect.ts'
import { until } from './testing.ts'

/** A Databricks CLI that answers every query with one row. */
const STUB = `#!/bin/sh
echo "$@" > "$HOME/last-args"
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
  await writeFile(join(analysis, 'analysis.yaml'), 'title: Panel\nprofile: P1\n')
  const out = await bundle()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(out, 'server/index.mjs')],
    // Claude starts in the root; the server finds the analysis in ASSAY_ANALYSIS.
    cwd: root,
    stderr: 'pipe',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: dir,
      TMPDIR: dir,
      ASSAY_ANALYSIS: analysis,
      ASSAY_ROOT: root,
      ASSAY_VENV: join(dir, 'no-venv'),
      ASSAY_KERNEL_RUNNER: resolve('python/analysis_kernel.py'),
    },
  })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return (result.content as { type: string; text: string }[])[0]?.text ?? ''
  }
  const file = (path: string) => readFile(join(analysis, path), 'utf8').catch(() => undefined)
  const kernel = async () => (JSON.parse((await file('.assay/runs.json')) ?? '{}') as { kernel?: { state?: string } }).kernel?.state
  return { dir, root, analysis, client, call, file, kernel, close: () => client.close() }
}

test('the bundled server lists its tools and answers each once', { timeout: 120_000 }, async () => {
  const s = await session()
  const { tools } = await s.client.listTools()
  expect(tools.map(tool => tool.name)).toEqual(['sql', 'python', 'trusted', 'park', 'close', 'focus', 'order', 'note', 'revise_note', 'link_notes', 'note_labels'])
  // On start: the files set up, none for notes.
  expect(await s.file('threads.md')).toBe('## Open\n\n## Closed\n')
  expect(await s.file('notes.md')).toBeUndefined()
  expect(await s.file('notes')).toBeUndefined()

  // The first run of an analysis with no notes ends with the search line.
  expect(await s.call('sql', { sql: 'SELECT 1 AS n', slug: 'one' })).toMatch(/^Query 001: 1 row\. Columns: n\nn\n1\nThis analysis has no notes yet\. Search notes\/ .*link_notes/)
  expect(await s.file('queries/001_one.csv')).toBe('n\n1\n')
  // The server started with the cwd at the root, wrote under the analysis, and took the target from analysis.yaml.
  expect(await readFile(join(s.dir, 'last-args'), 'utf8')).toMatch(/--profile P1 --warehouse 455a178462311474 /)
  expect(await readFile(join(s.root, 'queries/001_one.csv'), 'utf8').catch(() => undefined)).toBeUndefined()
  expect(await until(async () => (await s.kernel()) === 'missing')).toBe(true)
  expect(await s.call('python', { code: '1', slug: 'x' })).toBe(`The Python kernel is not available: ${VENV_ASSAY_HINT}`)
  expect(await s.call('trusted', { name: 'nope' })).toBe(`Cannot list the trusted calculations: ${VENV_ASSAY_HINT}`)
  expect(await s.call('park', { thread: 'Why is n 1?' })).toBe('Parked. 1 open thread.')
  expect(await s.call('park', { thread: 'Is it per site?' })).toBe('Parked. 2 open threads.')
  expect(await s.call('focus', { thread: '2' })).toBe('Focused: 1. Is it per site?')
  expect(await s.call('order', { threads: ['2'] })).toBe('Open threads now:\n1. Why is n 1?\n2. Is it per site?')
  expect(await s.call('close', { thread: '1', outcome: 'stub' })).toBe('Closed "Why is n 1?". Next open thread: 1. Is it per site?')
  const wrote = await s.call('note', { title: 'One', text: 'It is 1 [q 1].' })
  const [, file = '', id = ''] = /^Wrote notes\/((\d{8}T\d{6})-one\.md)\. Link it with \[\[\d{8}T\d{6}\]\]\.$/.exec(wrote) ?? []
  expect(file === '').toBe(false)
  expect(await readFile(join(s.root, 'notes', file), 'utf8')).toBe('# One\n\nIt is 1 [panel q 1].\n')
  expect(await s.call('revise_note', { id, old: '1 [panel', new: '2 [panel' })).toBe(`Revised notes/${file}.`)
  expect(await s.call('link_notes', { ids: [id] })).toMatch(/^Nothing new to link\./)
  expect(await s.call('revise_note', { id, delete: true })).toBe(`Deleted notes/${file}.`)
  expect(await s.file('analysis.yaml')).toBe('title: Panel\nprofile: P1\nnotes:\n  written: []\n  found: []\n')
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
    return JSON.parse((await s.file(`.assay/replies/${id}.json`)) ?? '{}') as { error?: string }
  }
  expect(await ask({ kind: 'sql', sql: 'SELECT 1 AS n', engine: 'databricks', slug: 'mine' })).toMatchObject({ number: 1 })
  expect(await s.file('queries/001_mine.sql')).toBe('-- author: user\nSELECT 1 AS n\n')
  expect(await ask({ kind: 'python', code: 'y = 2', slug: 'py' })).toEqual({ id: expect_id(n), error: `The Python kernel is not available: ${VENV_ASSAY_HINT}` })
  expect((await ask({ kind: 'interrupt' })).error).toBe('No kernel is running.')
  expect((await ask({ kind: 'restart' })).error).toBe(VENV_ASSAY_HINT)
  expect((await ask({ kind: 'replay', runs: [1] })).error).toBe('Run 001 is not a Python run.')
  expect(await ask({ kind: 'trust-list' })).toMatchObject({ proposals: [{ name: 'ones', kind: 'calculation', folder: 'lib/trusted' }] })
  expect(await ask({ kind: 'trust-answer', name: 'ones', answer: 'trust' })).toMatchObject({ error: 'No review of ones is waiting for an answer.' })
  expect(await ask({ kind: 'trust-check', name: 'ones' })).toMatchObject({ ok: true })
  // Without a venv the helper cannot check it: the review ends in error, written to the trust file.
  const review = async () => JSON.parse((await s.file('.assay/trust/ones.json')) ?? '{}') as { state?: string }
  expect(await until(async () => ['failed', 'error'].includes((await review()).state ?? ''), 120_000)).toBe(true)
  expect(await ask({ kind: 'trust-answer', name: 'ones', answer: 'trust' })).toMatchObject({ error: 'No review of ones is waiting for an answer.' })
  // Nothing reached the shared trusted/ folder.
  expect(await readFile(join(s.root, 'trusted/ones.sql'), 'utf8').catch(() => undefined)).toBeUndefined()
  // The user's runs, for the next prompt's notice.
  expect((JSON.parse((await s.file('.assay/user-runs.json')) ?? '[]') as unknown[])[0]).toEqual({ number: 1, language: 'sql' })
  await s.close()
})

const expect_id = (n: number) => `17600000000${String(n).padStart(2, '0')}-aaaaaa`

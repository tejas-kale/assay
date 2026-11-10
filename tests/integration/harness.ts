// The integration tests' world (docs/process/testing.md): a real venv from the lockfile, the bundled server and hooks, a scratch root
// that is a git repository with a trusted block committed, and the fake `databricks` first on PATH. Nothing here
// reaches Databricks, Postgres or a real Claude.
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TestContext } from 'node:test'
import { promisify } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { until } from '../../src/server/testing.ts'
import { bundle } from '../../src/testing/bundle.ts'

export const FIXTURES = resolve('tests/integration/fixtures')
export const FAKE_BIN = join(FIXTURES, 'bin')
const run = promisify(execFile)

export const SITES_BLOCK = `/*---
description: One row per site.
parameters: {}
block:
  grain: [site]
  columns:
    site: the site
    n: its count
---*/
-- grain: site
SELECT s.site, s.n FROM cint.mkt.sites s
`

export const TOTAL_CALCULATION = `/*---
description: Sessions at one site.
parameters:
  site: string
---*/
SELECT sum(n) AS total FROM cint.mkt.sites WHERE site = :site
`

let venv: Promise<string> | undefined

/**
 * A venv with ipykernel and the helpers: ASSAY_TEST_VENV when set, else built once from python/'s lockfile as the
 * packaged app builds its own (backend.ts's buildReleaseVenv), so the tests run the locked dependencies the app ships.
 */
export function testVenv(): Promise<string> {
  venv ??= (async () => {
    if (process.env.ASSAY_TEST_VENV) return process.env.ASSAY_TEST_VENV
    const dir = join(await mkdtemp(join(tmpdir(), 'assay-venv-')), 'venv')
    await run('uv', ['sync', '--quiet', '--frozen', '--no-editable', '--project', resolve('python')], { env: { ...process.env, UV_PROJECT_ENVIRONMENT: dir } })
    return dir
  })()
  return venv
}

export type World = { dir: string; root: string; analysis: string; venv: string; env: Record<string, string> }

/** A scratch root holding one analysis, deleted when `t` ends, with a trusted block and calculation committed, as trust requires. */
export async function world(t: TestContext): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'assay-int-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  const root = join(dir, 'notes-src')
  const analysis = join(root, 'analyses/panel')
  await mkdir(join(analysis, '.assay'), { recursive: true })
  await mkdir(join(root, 'trusted'), { recursive: true })
  await writeFile(join(analysis, 'analysis.yaml'), 'title: Panel sites\nprofile: P1\n')
  await writeFile(join(root, 'trusted/all_sites.sql'), SITES_BLOCK)
  await writeFile(join(root, 'trusted/site_total.sql'), TOTAL_CALCULATION)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', 'trusted')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'Trust all_sites')
  const venvDir = await testVenv()
  const env = {
    PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
    HOME: dir,
    TMPDIR: dir,
    ASSAY_ANALYSIS: analysis,
    ASSAY_ROOT: root,
    ASSAY_VENV: venvDir,
    ASSAY_KERNEL_RUNNER: resolve('python/analysis_kernel.py'),
  }
  return { dir, root, analysis, venv: venvDir, env }
}

/** The bundled MCP server on `w`, driven through the SDK's client as Claude drives it; closed when `t` ends. */
export async function server(t: TestContext, w: World) {
  const out = await bundle()
  const client = new Client({ name: 'integration', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(out, 'server/index.mjs')], cwd: w.root, stderr: 'pipe', env: w.env }))
  // Closing the client ends the server, and the server ends its kernel.
  t.after(() => client.close())
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return (result.content as { type: string; text: string }[])[0]?.text ?? ''
  }
  const file = (path: string) => readFile(join(w.analysis, path), 'utf8').catch(() => undefined)
  const kernelState = async () => (JSON.parse((await file('.assay/runs.json')) ?? '{}') as { kernel?: { state?: string } }).kernel?.state
  const kernelIdle = () => until(async () => (await kernelState()) === 'idle', 90_000)
  let n = 0
  /** A request as the app makes it: written to .assay/requests/, answered in .assay/replies/. */
  const ask = async (body: object): Promise<Record<string, unknown>> => {
    const id = `17700000000${String(++n).padStart(2, '0')}-int000`
    const dirOf = join(w.analysis, '.assay/requests')
    await mkdir(dirOf, { recursive: true })
    await writeFile(join(dirOf, `.${id}.tmp`), JSON.stringify({ id, ...body }))
    await rename(join(dirOf, `.${id}.tmp`), join(dirOf, `${id}.json`))
    await until(async () => (await file(`.assay/replies/${id}.json`)) !== undefined, 120_000)
    return JSON.parse((await file(`.assay/replies/${id}.json`)) ?? '{}') as Record<string, unknown>
  }
  return { client, call, file, ask, kernelIdle }
}

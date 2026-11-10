import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildVenv, installBackend, pruneVersions } from './backend.ts'
import type { UvRun } from './backend.ts'

/** A shipped backend (Resources/backend) and an empty app data folder. */
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'assay-backend-'))
  const shipped = join(dir, 'Resources/backend')
  await mkdir(join(shipped, 'plugin/.claude-plugin'), { recursive: true })
  await mkdir(join(shipped, 'python'), { recursive: true })
  await writeFile(join(shipped, 'plugin/.claude-plugin/plugin.json'), '{"name":"assay"}\n')
  await writeFile(join(shipped, 'python/pyproject.toml'), '[project]\nname = "assay"\n')
  return { dir, shipped, home: join(dir, 'Application Support/Assay') }
}

test('install copies the shipped backend under backend/<version>, leaving no temporary copy', async () => {
  const { shipped, home } = await scratch()
  const backend = await installBackend({ shipped, home, version: '0.4.3' })
  assert.equal(backend, join(home, 'backend/0.4.3'))
  assert.equal(await readFile(join(backend, 'plugin/.claude-plugin/plugin.json'), 'utf8'), '{"name":"assay"}\n')
  assert.deepEqual(await readdir(join(home, 'backend')), ['0.4.3'])
})

test('a second launch of the same version copies nothing', async () => {
  const { shipped, home } = await scratch()
  await installBackend({ shipped, home, version: '0.4.3' })
  await writeFile(join(shipped, 'python/pyproject.toml'), 'changed\n')
  const backend = await installBackend({ shipped, home, version: '0.4.3' })
  assert.equal(await readFile(join(backend, 'python/pyproject.toml'), 'utf8'), '[project]\nname = "assay"\n')
})

test('pruning deletes older versions and their venvs, and keeps this one and the one before', async () => {
  const { home } = await scratch()
  for (const name of ['0.4.1', '0.4.2', '0.4.3', 'dev']) {
    await mkdir(join(home, 'backend', name), { recursive: true })
    await mkdir(join(home, 'venvs', name), { recursive: true })
    await writeFile(join(home, 'venvs', `${name}.status.json`), '{"state":"ready"}\n')
  }
  await pruneVersions(home, '0.4.3')
  assert.deepEqual((await readdir(join(home, 'backend'))).sort((a, b) => a.localeCompare(b)), ['0.4.2', '0.4.3', 'dev'])
  assert.deepEqual((await readdir(join(home, 'venvs'))).sort((a, b) => a.localeCompare(b)), ['0.4.2', '0.4.2.status.json', '0.4.3', '0.4.3.status.json', 'dev', 'dev.status.json'])
})

test('pruning a first launch, with no folders yet, does nothing', async () => {
  const { home } = await scratch()
  await pruneVersions(home, '0.4.3')
  assert.deepEqual(await readdir(home).catch(() => []), [])
})

/** A uv that records its arguments and environment, and makes the venv's python unless told to fail. */
function fakeUv(fail?: string) {
  const calls: { args: readonly string[]; env: Record<string, string> }[] = []
  const run: UvRun = async (args, env) => {
    calls.push({ args, env })
    if (fail) return { error: fail }
    const venv = String(env.UV_PROJECT_ENVIRONMENT)
    await mkdir(join(venv, 'bin'), { recursive: true })
    await writeFile(join(venv, 'bin/python'), '')
    return {}
  }
  return { calls, run }
}

test('the venv is built frozen and non-editable into venvs/<version>, and marked ready', async () => {
  const { home } = await scratch()
  const uv = fakeUv()
  const venv = join(home, 'venvs/0.4.3')
  const states: string[] = []
  const built = await buildVenv({ project: '/b/python', venv, isEditable: false, runUv: uv.run, onState: state => states.push(state.state) })
  assert.deepEqual(built, { state: 'ready' })
  assert.deepEqual(uv.calls, [{ args: ['sync', '--frozen', '--no-editable', '--project', '/b/python'], env: { UV_PROJECT_ENVIRONMENT: venv } }])
  assert.deepEqual(states, ['building', 'ready'])
  assert.equal(await readFile(`${venv}.status.json`, 'utf8'), '{"state":"ready"}\n')
})

test("a version's built venv is not built again", async () => {
  const { home } = await scratch()
  const uv = fakeUv()
  const venv = join(home, 'venvs/0.4.3')
  await buildVenv({ project: '/b/python', venv, isEditable: false, runUv: uv.run })
  await buildVenv({ project: '/b/python', venv, isEditable: false, runUv: uv.run })
  assert.equal(uv.calls.length, 1)
})

test('the dev venv is editable and synced at every launch, so a changed lock reaches it', async () => {
  const { home } = await scratch()
  const uv = fakeUv()
  const venv = join(home, 'venvs/dev')
  await buildVenv({ project: '/repo/python', venv, isEditable: true, runUv: uv.run })
  await buildVenv({ project: '/repo/python', venv, isEditable: true, runUv: uv.run })
  assert.equal(uv.calls.length, 2)
  assert.deepEqual(uv.calls[0]?.args, ['sync', '--frozen', '--project', '/repo/python'])
})

test('a failed build is written with its error, and the next launch tries again', async () => {
  const { home } = await scratch()
  const venv = join(home, 'venvs/0.4.3')
  await mkdir(join(home, 'venvs'), { recursive: true })
  const failing = fakeUv('error: Failed to fetch numpy')
  assert.deepEqual(await buildVenv({ project: '/b/python', venv, isEditable: false, runUv: failing.run }), { state: 'failed', error: 'error: Failed to fetch numpy' })
  assert.equal(await readFile(`${venv}.status.json`, 'utf8'), '{"state":"failed","error":"error: Failed to fetch numpy"}\n')
  const working = fakeUv()
  assert.deepEqual(await buildVenv({ project: '/b/python', venv, isEditable: false, runUv: working.run }), { state: 'ready' })
  assert.equal(working.calls.length, 1)
})

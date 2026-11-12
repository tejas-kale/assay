import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { backendStamp, buildReleaseVenv, installBackend, installedStamp, pruneVersions, syncDevVenv } from './backend.ts'
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

test('a second launch of the same version and content copies nothing', async () => {
  const { shipped, home } = await scratch()
  const backend = await installBackend({ shipped, home, version: '0.4.3' })
  const before = (await stat(join(backend, 'python/pyproject.toml'))).ino
  await installBackend({ shipped, home, version: '0.4.3' })
  assert.equal((await stat(join(backend, 'python/pyproject.toml'))).ino, before)
})

test('an installed backend edited since, its stamp left alone, is copied again (audit UP-1)', async () => {
  const { shipped, home } = await scratch()
  const backend = await installBackend({ shipped, home, version: '0.4.3' })
  await writeFile(join(backend, 'python/pyproject.toml'), 'tampered\n')
  await writeFile(join(backend, 'python/extra.py'), 'import os\n')
  await installBackend({ shipped, home, version: '0.4.3' })
  assert.equal(await readFile(join(backend, 'python/pyproject.toml'), 'utf8'), '[project]\nname = "assay"\n')
  assert.deepEqual(await readdir(join(backend, 'python')), ['pyproject.toml'])
})

test('a launch whose shipped content changed under the same version replaces the backend', async () => {
  // Every local build is 0.1.0: a reinstall must not keep running the first install's plugin and server.
  const { shipped, home } = await scratch()
  await installBackend({ shipped, home, version: '0.4.3' })
  await writeFile(join(shipped, 'python/pyproject.toml'), 'changed\n')
  const backend = await installBackend({ shipped, home, version: '0.4.3' })
  assert.equal(await readFile(join(backend, 'python/pyproject.toml'), 'utf8'), 'changed\n')
  assert.deepEqual(await readdir(join(home, 'backend')), ['0.4.3'])
  assert.equal(await installedStamp(backend), await backendStamp(shipped))
})

test('a backend installed before stamps existed is replaced', async () => {
  const { shipped, home } = await scratch()
  await mkdir(join(home, 'backend/0.4.3/python'), { recursive: true })
  await writeFile(join(home, 'backend/0.4.3/python/pyproject.toml'), 'old\n')
  const backend = await installBackend({ shipped, home, version: '0.4.3' })
  assert.equal(await readFile(join(backend, 'python/pyproject.toml'), 'utf8'), '[project]\nname = "assay"\n')
})

test('the stamp follows file names and contents', async () => {
  const { shipped } = await scratch()
  const first = await backendStamp(shipped)
  assert.equal(await backendStamp(shipped), first)
  await writeFile(join(shipped, 'python/new.py'), '')
  assert.notEqual(await backendStamp(shipped), first)
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

test('the venv is built frozen, non-editable and without the dev group into venvs/<version>, and marked ready', async () => {
  const { home } = await scratch()
  const uv = fakeUv()
  const venv = join(home, 'venvs/0.4.3')
  const states: string[] = []
  const built = await buildReleaseVenv({ project: '/b/python', venv, runUv: uv.run, stamp: 's1', onState: state => states.push(state.state) })
  assert.deepEqual(built, { state: 'ready' })
  assert.deepEqual(uv.calls, [{ args: ['sync', '--frozen', '--no-editable', '--no-dev', '--project', '/b/python'], env: { UV_PROJECT_ENVIRONMENT: venv } }])
  assert.deepEqual(states, ['building', 'ready'])
  assert.equal(await readFile(`${venv}.status.json`, 'utf8'), '{"state":"ready"}\n')
})

test("a version's built venv is not built again", async () => {
  const { home } = await scratch()
  const uv = fakeUv()
  const venv = join(home, 'venvs/0.4.3')
  await buildReleaseVenv({ project: '/b/python', venv, runUv: uv.run, stamp: 's1' })
  await buildReleaseVenv({ project: '/b/python', venv, runUv: uv.run, stamp: 's1' })
  assert.equal(uv.calls.length, 1)
})

test('a ready venv built from another backend is deleted and built again', async () => {
  const { home } = await scratch()
  const uv = fakeUv()
  const venv = join(home, 'venvs/0.4.3')
  await buildReleaseVenv({ project: '/b/python', venv, runUv: uv.run, stamp: 's1' })
  await writeFile(join(venv, 'old-helper'), '')
  assert.deepEqual(await buildReleaseVenv({ project: '/b/python', venv, runUv: uv.run, stamp: 's2' }), { state: 'ready' })
  assert.equal(uv.calls.length, 2)
  assert.deepEqual(await readdir(venv), ['.assay-stamp', 'bin'])
})

test('the dev venv is editable and synced at every launch, so a changed lock reaches it', async () => {
  const { home } = await scratch()
  const uv = fakeUv()
  const venv = join(home, 'venvs/dev')
  await syncDevVenv({ project: '/repo/python', venv, runUv: uv.run })
  await syncDevVenv({ project: '/repo/python', venv, runUv: uv.run })
  assert.equal(uv.calls.length, 2)
  assert.deepEqual(uv.calls[0]?.args, ['sync', '--frozen', '--project', '/repo/python'])
})

test('a failed build is written with its error, and the next launch tries again', async () => {
  const { home } = await scratch()
  const venv = join(home, 'venvs/0.4.3')
  await mkdir(join(home, 'venvs'), { recursive: true })
  const failing = fakeUv('error: Failed to fetch numpy')
  assert.deepEqual(await buildReleaseVenv({ project: '/b/python', venv, runUv: failing.run, stamp: 's1' }), { state: 'failed', error: 'error: Failed to fetch numpy' })
  assert.equal(await readFile(`${venv}.status.json`, 'utf8'), '{"state":"failed","error":"error: Failed to fetch numpy"}\n')
  const working = fakeUv()
  assert.deepEqual(await buildReleaseVenv({ project: '/b/python', venv, runUv: working.run, stamp: 's1' }), { state: 'ready' })
  assert.equal(working.calls.length, 1)
})

test('a venv whose folder cannot be made fails as a value, with the reason, and says so', async () => {
  const { home } = await scratch()
  await mkdir(home, { recursive: true })
  // venvs/ is a file, so nothing can be written under it.
  await writeFile(join(home, 'venvs'), '')
  const states: string[] = []
  const built = await buildReleaseVenv({ project: '/b/python', venv: join(home, 'venvs/0.4.3'), runUv: fakeUv().run, stamp: 's1', onState: state => states.push(state.state) })
  assert.ok(built.state === 'failed' && built.error.includes('venvs'), JSON.stringify(built))
  assert.deepEqual(states, ['failed'])
})

test('a linked or added __pycache__ in the installed backend makes the launch replace the copy (audit UP-1)', async () => {
  const { dir, shipped, home } = await scratch()
  const backend = await installBackend({ shipped, home, version: '0.4.3' })
  await mkdir(join(dir, 'evil'))
  await writeFile(join(dir, 'evil/x.pyc'), 'bytecode')
  await symlink(join(dir, 'evil'), join(backend, 'python/__pycache__'))
  await installBackend({ shipped, home, version: '0.4.3' })
  assert.deepEqual(await readdir(join(backend, 'python')), ['pyproject.toml'])
  await mkdir(join(backend, 'python/__pycache__'))
  await installBackend({ shipped, home, version: '0.4.3' })
  assert.deepEqual(await readdir(join(backend, 'python')), ['pyproject.toml'])
  await symlink('/etc/hosts', join(backend, 'plugin/link'))
  await installBackend({ shipped, home, version: '0.4.3' })
  await assert.rejects(lstat(join(backend, 'plugin/link')))
})

test('a shipped backend that holds bytecode is installed without it, and then launches without a copy', async () => {
  const { shipped, home } = await scratch()
  await mkdir(join(shipped, 'python/__pycache__'))
  await writeFile(join(shipped, 'python/__pycache__/m.cpython-312.pyc'), 'x')
  await writeFile(join(shipped, 'python/stray.pyc'), 'x')
  const backend = await installBackend({ shipped, home, version: '0.4.3' })
  assert.deepEqual(await readdir(join(backend, 'python')), ['pyproject.toml'])
  const before = (await stat(join(backend, 'python/pyproject.toml'))).ino
  await installBackend({ shipped, home, version: '0.4.3' })
  assert.equal((await stat(join(backend, 'python/pyproject.toml'))).ino, before)
})

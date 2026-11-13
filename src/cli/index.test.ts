import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'

import { parseSettings } from '../core/settings.ts'

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'assay-cli-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'scratch')
  const settings = join(home, 'Library/Application Support/assay/settings.json')
  await mkdir(join(root, 'analyses/test-analysis'), { recursive: true })
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve('src/cli/index.ts'), ...args], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
  })
  return { home, root, settings, run }
}

test('CLI saves and shows a canonical root without preparing a backend', async t => {
  const { root, settings, run } = await fixture(t)
  const saved = run('root', join(root, 'analyses/test-analysis'))
  assert.equal(saved.status, 0, saved.stderr)
  assert.equal(saved.stdout.trim(), await realpath(root))
  assert.equal(run('root').stdout, saved.stdout)
  assert.equal(parseSettings(await readFile(settings, 'utf8')).root, await realpath(root))
})

test('CLI root preserves preferences and rejects unsafe or missing folders without changing settings', async t => {
  const { home, root, settings, run } = await fixture(t)
  await mkdir(join(home, 'Library/Application Support/assay'), { recursive: true })
  await writeFile(settings, '{"strip":{"side":"left"}}')
  assert.equal(run('root', root).status, 0)
  const saved = await readFile(settings, 'utf8')
  assert.equal(parseSettings(saved).strip.side, 'left')
  for (const input of [home, '/', join(root, 'missing'), 'relative']) {
    const rejected = run('root', input)
    assert.equal(rejected.status, 1)
    assert.notEqual(rejected.stderr, '')
    assert.equal(await readFile(settings, 'utf8'), saved)
  }
  assert.equal(run('root', root, 'extra').status, 1)
  assert.equal(run('unknown').status, 1)
})

test('CLI root reports an unset root without creating settings', async t => {
  const { settings, run } = await fixture(t)
  const result = run('root')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Enter a folder/)
  await assert.rejects(readFile(settings), { code: 'ENOENT' })
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveRoot } from './rootPath.ts'

async function scratch() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'assay-rootpath-')))
  const home = join(dir, 'me')
  await mkdir(join(home, 'work'), { recursive: true })
  return { dir, home }
}

test('a folder inside home resolves to its real path', async () => {
  const { dir, home } = await scratch()
  await symlink(join(home, 'work'), join(dir, 'alias'))
  assert.deepEqual(await resolveRoot(join(dir, 'alias'), home), { ok: true, path: join(home, 'work') })
})

test('a link to the home folder, or to one above it, is refused (audit UI-5)', async () => {
  const { dir, home } = await scratch()
  await symlink(home, join(dir, 'to-home'))
  await symlink(dir, join(dir, 'to-above'))
  await symlink('/', join(dir, 'to-slash'))
  for (const link of ['to-home', 'to-above', 'to-slash']) assert.equal((await resolveRoot(join(dir, link), home)).ok, false, link)
})

test('the home folder itself is refused when home is given through a link', async () => {
  const { dir, home } = await scratch()
  await symlink(home, join(dir, 'home-link'))
  assert.equal((await resolveRoot(home, join(dir, 'home-link'))).ok, false)
})

test('a folder whose name differs from home only in case is refused, as on a case-insensitive disk (audit UI-5)', async () => {
  const { dir, home } = await scratch()
  // On a case-insensitive disk ME is already home's folder; elsewhere it is made.
  await mkdir(join(dir, 'ME'), { recursive: true })
  assert.equal((await resolveRoot(join(dir, 'ME'), home)).ok, false)
})

test('a missing folder and an empty entry are refused', async () => {
  const { home } = await scratch()
  assert.equal((await resolveRoot(join(home, 'nope'), home)).ok, false)
  assert.equal((await resolveRoot('', home)).ok, false)
})

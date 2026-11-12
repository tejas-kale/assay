import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { writeRequest } from './requestFiles.ts'

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assay-req-'))
  const analysis = join(dir, 'analysis')
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(analysis)
  await mkdir(elsewhere)
  return { analysis, elsewhere }
}

test('a request is written into real .assay/requests folders it creates itself', async () => {
  const { analysis } = await scratch()
  const result = await writeRequest(analysis, { kind: 'trust-check', name: 'calc' })
  assert.equal(result.ok, true)
  assert.equal((await lstat(join(analysis, '.assay/requests'))).isDirectory(), true)
  const names = await readdir(join(analysis, '.assay/requests'))
  assert.equal(names.length, 1)
  assert.match(await readFile(join(analysis, '.assay/requests', names[0] ?? ''), 'utf8'), /trust-check/)
  assert.equal(await readFile(join(analysis, '.assay/.gitignore'), 'utf8'), '*\n')
})

test('a .assay that is a link is refused, and nothing is written where it points', async () => {
  const { analysis, elsewhere } = await scratch()
  await symlink(elsewhere, join(analysis, '.assay'), 'dir')
  const result = await writeRequest(analysis, { kind: 'trust-check', name: 'calc' })
  assert.equal(result.ok, false)
  assert.deepEqual(await readdir(elsewhere), [])
})

test('a .assay/requests that is a link, or not a folder, is refused', async () => {
  const { analysis, elsewhere } = await scratch()
  await mkdir(join(analysis, '.assay'))
  await symlink(elsewhere, join(analysis, '.assay/requests'), 'dir')
  const result = await writeRequest(analysis, { kind: 'trust-check', name: 'calc' })
  assert.equal(result.ok, false)
  assert.deepEqual(await readdir(elsewhere), [])
  const { analysis: other } = await scratch()
  await mkdir(join(other, '.assay'))
  await writeFile(join(other, '.assay/requests'), 'a file')
  assert.equal((await writeRequest(other, { kind: 'trust-check', name: 'calc' })).ok, false)
})

test('a .gitignore that is a link is not written through', async () => {
  const { analysis, elsewhere } = await scratch()
  await mkdir(join(analysis, '.assay'))
  await symlink(join(elsewhere, 'target'), join(analysis, '.assay/.gitignore'))
  assert.equal((await writeRequest(analysis, { kind: 'trust-check', name: 'calc' })).ok, true)
  assert.deepEqual(await readdir(elsewhere), [])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveInside } from './safePath.ts'

const folder = '/root/analyses/a'

test('a relative path inside the folder resolves', () => {
  assert.equal(resolveInside(folder, 'notes/001-x.md'), '/root/analyses/a/notes/001-x.md')
  assert.equal(resolveInside(folder, './notes/../notes/x.md'), '/root/analyses/a/notes/x.md')
})

test('an absolute path inside the folder is accepted', () => {
  assert.equal(resolveInside(folder, '/root/analyses/a/notes/x.md'), '/root/analyses/a/notes/x.md')
})

test('paths that escape are refused', () => {
  assert.equal(resolveInside(folder, '../b/notes.md'), undefined)
  assert.equal(resolveInside(folder, 'notes/../../b/x.md'), undefined)
  assert.equal(resolveInside(folder, '/etc/passwd'), undefined)
  assert.equal(resolveInside(folder, '..'), undefined)
})

test('a sibling folder with the same prefix is outside', () => {
  assert.equal(resolveInside(folder, '../a-other/x.md'), undefined)
  assert.equal(resolveInside(folder, '/root/analyses/a-other/x.md'), undefined)
})

test('empty, the folder itself and NUL are refused', () => {
  assert.equal(resolveInside(folder, ''), undefined)
  assert.equal(resolveInside(folder, '.'), undefined)
  assert.equal(resolveInside(folder, 'x\0.md'), undefined)
})

test('a trailing slash on the folder does not matter', () => {
  assert.equal(resolveInside(`${folder}/`, 'x.md'), '/root/analyses/a/x.md')
})

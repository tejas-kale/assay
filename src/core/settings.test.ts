import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeRoot, parseSettings, rootFor, serializeSettings } from './settings.ts'

test('no file, bad JSON or a wrong type means no root, never a default folder', () => {
  for (const text of [undefined, '', 'not json', '[]', 'null', '{}', '{"root":5}', '{"root":""}']) {
    assert.deepEqual(parseSettings(text), {}, String(text))
  }
})

test('a saved root reads back', () => {
  assert.deepEqual(parseSettings(serializeSettings({ root: '/a/b' })), { root: '/a/b' })
})

test('normalizeRoot expands ~ and tidies the path', () => {
  assert.deepEqual(normalizeRoot('~', '/home/me'), { ok: true, path: '/home/me' })
  assert.deepEqual(normalizeRoot(' ~/x/y/ ', '/home/me'), { ok: true, path: '/home/me/x/y' })
  assert.deepEqual(normalizeRoot('/a/./b/', '/home/me'), { ok: true, path: '/a/b' })
})

test('normalizeRoot refuses empty and relative paths, and ~user', () => {
  for (const input of ['', '   ', 'a/b', './a', '~other/x']) {
    assert.equal(normalizeRoot(input, '/home/me').ok, false, input)
  }
})

test('picking analyses/ or one analysis inside it means the folder above', () => {
  assert.equal(rootFor('/n/analyses'), '/n')
  assert.equal(rootFor('/n/analyses/feedback-x'), '/n')
  // The old parents are gone from the app: the migration moves their folders into analyses/.
  assert.equal(rootFor('/n/investigations/old'), '/n/investigations/old')
  assert.equal(rootFor('/n'), '/n')
  assert.deepEqual(normalizeRoot('~/notes-src/analyses/x/', '/home/me'), { ok: true, path: '/home/me/notes-src' })
})

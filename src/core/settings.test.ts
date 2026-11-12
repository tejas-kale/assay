import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeRoot, parseSettings, rootFor, serializeSettings } from './settings.ts'
import { DEFAULT_STRIP } from './strip.ts'
import { defaultTabPrefs, setTabOn } from './tabs.ts'

const DEFAULTS = { tabs: defaultTabPrefs(), strip: DEFAULT_STRIP }

test('no file, bad JSON or a wrong type means no root, never a default folder, and the default tabs and strip', () => {
  for (const text of [undefined, '', 'not json', '[]', 'null', '{}', '{"root":5}', '{"root":""}']) {
    assert.deepEqual(parseSettings(text), DEFAULTS, String(text))
  }
})

test('saved settings read back', () => {
  const settings = { root: '/a/b', tabs: setTabOn(defaultTabPrefs(), 'trust', false), strip: { ...DEFAULT_STRIP, side: 'left' as const, autoHide: true } }
  assert.deepEqual(parseSettings(serializeSettings(settings)), settings)
})

test('a settings file from before tabs and strip gets their defaults and keeps its root', () => {
  assert.deepEqual(parseSettings('{"root":"/a"}'), { root: '/a', ...DEFAULTS })
})

test('the old strip.json side moves in when settings.json has no strip yet', () => {
  assert.equal(parseSettings('{"root":"/a"}', '{"side":"left"}').strip.side, 'left')
  assert.equal(parseSettings(undefined, '{"side":"left"}').strip.side, 'left')
  assert.equal(parseSettings('{"strip":{"side":"bottom"}}', '{"side":"left"}').strip.side, 'bottom')
  assert.equal(parseSettings('{}', 'not json').strip.side, 'bottom')
})

test('normalizeRoot expands ~ and tidies the path', () => {
  assert.deepEqual(normalizeRoot(' ~/x/y/ ', '/home/me'), { ok: true, path: '/home/me/x/y' })
  assert.deepEqual(normalizeRoot('/a/./b/', '/home/me'), { ok: true, path: '/a/b' })
})

test('normalizeRoot refuses empty and relative paths, and ~user', () => {
  for (const input of ['', '   ', 'a/b', './a', '~other/x']) {
    assert.equal(normalizeRoot(input, '/home/me').ok, false, input)
  }
})

test('normalizeRoot refuses the home folder and every folder above it (audit UI-5)', () => {
  for (const input of ['~', '~/', '/', '/home', '/home/me', '/home/me/analyses', '/home/../']) {
    assert.equal(normalizeRoot(input, '/home/me').ok, false, input)
  }
  assert.deepEqual(normalizeRoot('/home/me2', '/home/me'), { ok: true, path: '/home/me2' })
})

test('picking analyses/ or one analysis inside it means the folder above', () => {
  assert.equal(rootFor('/n/analyses'), '/n')
  assert.equal(rootFor('/n/analyses/feedback-x'), '/n')
  // The old parents are gone from the app: the migration moves their folders into analyses/.
  assert.equal(rootFor('/n/investigations/old'), '/n/investigations/old')
  assert.equal(rootFor('/n'), '/n')
  assert.deepEqual(normalizeRoot('~/notes-src/analyses/x/', '/home/me'), { ok: true, path: '/home/me/notes-src' })
})

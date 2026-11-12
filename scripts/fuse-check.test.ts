import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { FUSE_NAMES, fuseProblems } from './fuse-check.ts'

const ON = 49
const OFF = 48
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { build: { electronFuses: Record<string, boolean> } }
const settings = pkg.build.electronFuses
const wireFor = (expected: Record<string, boolean>) => Object.fromEntries(FUSE_NAMES.map((name, i) => [i, expected[name] ? ON : OFF]))

test('package.json decides every fuse, and an app built to match it passes', () => {
  assert.deepEqual(fuseProblems(settings, wireFor(settings)), [])
})

test('the fuses that keep code out of the app are set: no ELECTRON_RUN_AS_NODE, no inspector, asar only and checked', () => {
  assert.equal(settings['runAsNode'], false)
  assert.equal(settings['enableNodeOptionsEnvironmentVariable'], false)
  assert.equal(settings['enableNodeCliInspectArguments'], false)
  assert.equal(settings['enableEmbeddedAsarIntegrityValidation'], true)
  assert.equal(settings['onlyLoadAppFromAsar'], true)
})

test('a fuse the build left as Electron ships it fails the check', () => {
  const wire = { ...wireFor(settings), 0: ON }
  assert.deepEqual(fuseProblems(settings, wire), ['runAsNode: expected off, the app has on'])
})

test('a fuse missing from the binary, or in another state, fails', () => {
  const wire: Record<number, number | undefined> = { ...wireFor(settings), 7: undefined, 6: 114 }
  assert.deepEqual(fuseProblems(settings, wire), [
    'loadBrowserProcessSpecificV8Snapshot: expected off, the app has state 114',
    'grantFileProtocolExtraPrivileges: expected on, the app has no such fuse',
  ])
})

test('a fuse package.json does not set fails, so a new one is decided rather than inherited', () => {
  const rest = Object.fromEntries(Object.entries(settings).filter(([name]) => name !== 'runAsNode'))
  assert.deepEqual(fuseProblems(rest, wireFor(settings)), ['runAsNode: not set in package.json build.electronFuses'])
})

test('an enabled fuse reads as on', () => {
  const expected = { ...settings, enableCookieEncryption: false }
  assert.deepEqual(fuseProblems(expected, wireFor(settings)), ['enableCookieEncryption: expected off, the app has on'])
})

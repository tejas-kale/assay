import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inputOverride } from './terminalKeys.ts'

const key = (key: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods,
})

test('Shift+Enter becomes ESC CR', () => {
  assert.equal(inputOverride(key('Enter', { shiftKey: true })), '\x1b\r')
})

test('plain Enter and other chords are left alone', () => {
  assert.equal(inputOverride(key('Enter')), undefined)
  assert.equal(inputOverride(key('Enter', { shiftKey: true, ctrlKey: true })), undefined)
  assert.equal(inputOverride(key('Enter', { shiftKey: true, altKey: true })), undefined)
  assert.equal(inputOverride(key('Enter', { shiftKey: true, metaKey: true })), undefined)
  assert.equal(inputOverride(key('a', { shiftKey: true })), undefined)
})

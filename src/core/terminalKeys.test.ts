import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inputOverride, leavesTerminal } from './terminalKeys.ts'

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

test('Cmd with a character key goes to the app menu, not the pty', () => {
  assert.equal(leavesTerminal(key('q', { metaKey: true })), true)
  assert.equal(leavesTerminal(key('h', { metaKey: true })), true)
  assert.equal(leavesTerminal(key(',', { metaKey: true })), true)
})

test('keys without Cmd, and Cmd with non-character keys, stay in the terminal', () => {
  assert.equal(leavesTerminal(key('q')), false)
  assert.equal(leavesTerminal(key('q', { ctrlKey: true })), false)
  assert.equal(leavesTerminal(key('Backspace', { metaKey: true })), false)
  assert.equal(leavesTerminal(key('ArrowLeft', { metaKey: true })), false)
})

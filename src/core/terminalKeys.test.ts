import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inputOverride, leavesTerminal } from './terminalKeys.ts'

const key = (key: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods,
})

test('Shift+Enter becomes ESC CR', () => {
  assert.equal(inputOverride(key('Enter', { shiftKey: true })), '\x1b\r')
})

test('Ctrl+V sends the control byte so Claude reads an image from the clipboard', () => {
  assert.equal(inputOverride(key('v', { ctrlKey: true })), '\x16')
  assert.equal(inputOverride(key('V', { ctrlKey: true, shiftKey: true })), undefined)
  assert.equal(inputOverride(key('v', { metaKey: true })), undefined)
  assert.equal(inputOverride(key('v', { ctrlKey: true, altKey: true })), undefined)
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

test('wheelLines carries trackpad remainders and caps a fling', async () => {
  const { wheelLines } = await import('./terminalKeys.ts')
  const [a, ra] = wheelLines(20, 0)
  assert.equal(a, 0)
  const [b] = wheelLines(20, ra)
  assert.equal(b, 1)
  assert.equal(wheelLines(-66, 0)[0], -2)
  assert.equal(wheelLines(10_000, 0)[0], 5)
})

test('wheelReport encodes SGR and X10 wheel buttons', async () => {
  const { wheelReport } = await import('./terminalKeys.ts')
  assert.equal(wheelReport(-1, 3, 4, true), '\x1b[<64;3;4M')
  assert.equal(wheelReport(2, 1, 1, true), '\x1b[<65;1;1M\x1b[<65;1;1M')
  assert.equal(wheelReport(-1, 1, 1, false), '\x1b[M`!!')
})

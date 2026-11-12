import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dialogKey, paletteKey } from './dialogKeys.ts'

test('Enter confirms and Escape cancels, except while an IME composes', () => {
  assert.equal(dialogKey('Enter', false), 'confirm')
  assert.equal(dialogKey('Escape', false), 'cancel')
  assert.equal(dialogKey('a', false), undefined)
  assert.equal(dialogKey('Enter', true), undefined)
})

test('the palette steps with the arrows or Ctrl-n and Ctrl-p, and shares the dialog keys', () => {
  assert.equal(paletteKey('ArrowDown', false, false), 'next')
  assert.equal(paletteKey('n', true, false), 'next')
  assert.equal(paletteKey('ArrowUp', false, false), 'previous')
  assert.equal(paletteKey('p', true, false), 'previous')
  assert.equal(paletteKey('n', false, false), undefined)
  assert.equal(paletteKey('Enter', false, false), 'confirm')
  assert.equal(paletteKey('Escape', true, false), 'cancel')
  assert.equal(paletteKey('ArrowDown', false, true), undefined)
})

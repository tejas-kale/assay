import assert from 'node:assert/strict'
import { test } from 'node:test'

import { searchKey } from './searchKey.ts'

test('search keys: movement, preview toggle and scroll, confirm and cancel', () => {
  assert.equal(searchKey('ArrowDown', false, false), 'next')
  assert.equal(searchKey('p', true, false), 'previous')
  assert.equal(searchKey('Tab', false, false), 'togglePreview')
  assert.equal(searchKey('d', true, false), 'scrollDown')
  assert.equal(searchKey('u', true, false), 'scrollUp')
  assert.equal(searchKey('d', false, false), undefined)
  assert.equal(searchKey('Enter', false, false), 'confirm')
  assert.equal(searchKey('Escape', false, false), 'cancel')
  assert.equal(searchKey('Tab', false, true), undefined)
})

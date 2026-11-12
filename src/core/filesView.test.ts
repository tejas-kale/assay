import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chipLabel, openedMessage, previewKey, splitPath, stepImage } from './filesView.ts'

test('the chip says what Enter does', () => {
  const file = (path: string, kind: 'text' | 'image' | 'other') => ({ path, kind, size: 1, mtimeMs: 1 })
  assert.equal(chipLabel(file('a.py', 'text')), 'nvim')
  assert.equal(chipLabel(file('a.mmd', 'text')), 'browser')
  assert.equal(chipLabel(file('a.mmd', 'other')), 'open')
  assert.equal(chipLabel(file('a.png', 'image')), 'preview')
})

test('a path splits at its last slash', () => {
  assert.deepEqual(splitPath('a/b/c.txt'), { folder: 'a/b/', name: 'c.txt' })
  assert.deepEqual(splitPath('c.txt'), { folder: '', name: 'c.txt' })
})

test('what opening a file says', () => {
  assert.equal(openedMessage('nvim', 'a'), 'Opened a in Neovim')
  assert.equal(openedMessage('browser', 'a'), 'Opened the chart of a in your browser')
  assert.equal(openedMessage('finder', 'a'), 'Showed a in Finder: Assay opens only documents in their app')
  assert.equal(openedMessage('default', 'a'), 'Opened a')
})

test('stepping among images wraps, and stops when there is no other image', () => {
  const images = [{ path: 'a' }, { path: 'b' }, { path: 'c' }]
  assert.equal(stepImage(images, 'a', 1)?.path, 'b')
  assert.equal(stepImage(images, 'c', 1)?.path, 'a')
  assert.equal(stepImage(images, 'a', -1)?.path, 'c')
  assert.equal(stepImage([{ path: 'a' }], 'a', 1), undefined)
  assert.equal(stepImage<{ path: string }>([], 'a', 1), undefined)
})

test('preview keys', () => {
  assert.deepEqual(['Escape', 'Enter', ' '].map(previewKey), ['close', 'close', 'close'])
  assert.deepEqual(['j', 'l', 'ArrowRight', 'ArrowDown'].map(previewKey), ['next', 'next', 'next', 'next'])
  assert.deepEqual(['k', 'h', 'ArrowLeft', 'ArrowUp'].map(previewKey), ['previous', 'previous', 'previous', 'previous'])
  assert.equal(previewKey('x'), undefined)
})

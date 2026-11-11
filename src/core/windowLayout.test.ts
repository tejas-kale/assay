import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_STRIP } from './strip.ts'
import { frameFor } from './windowLayout.ts'

const content = { width: 1000, height: 600 }

test('the strip sits along the bottom and the views take the rest', () => {
  assert.deepEqual(frameFor(content, DEFAULT_STRIP, 1), {
    strip: { x: 0, y: 572, width: 1000, height: 28 },
    views: { x: 0, y: 0, width: 1000, height: 572 },
  })
})

test('on the left the strip is a column and the views start after it', () => {
  assert.deepEqual(frameFor(content, { ...DEFAULT_STRIP, side: 'left' }, 2), {
    strip: { x: 0, y: 0, width: 28, height: 600 },
    views: { x: 28, y: 0, width: 972, height: 600 },
  })
})

test('auto-hide with one analysis hides the strip and the views fill the window', () => {
  const frame = frameFor(content, { ...DEFAULT_STRIP, autoHide: true }, 1)
  assert.deepEqual(frame, { strip: undefined, views: { x: 0, y: 0, width: 1000, height: 600 } })
  assert.notEqual(frameFor(content, { ...DEFAULT_STRIP, autoHide: true }, 2).strip, undefined)
})

test('a window narrower or shorter than the strip never gets a negative size', () => {
  assert.deepEqual(frameFor({ width: 10, height: 600 }, { ...DEFAULT_STRIP, side: 'left' }, 1).views, { x: 10, y: 0, width: 0, height: 600 })
  assert.deepEqual(frameFor({ width: 800, height: 10 }, DEFAULT_STRIP, 1).views, { x: 0, y: 0, width: 800, height: 0 })
})

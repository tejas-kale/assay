import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatAge } from './age.ts'

const now = Date.UTC(2026, 10, 1)
const ago = (seconds: number) => formatAge(now - seconds * 1000, now)

test('units step up at their boundaries', () => {
  assert.equal(ago(0), 'just now')
  assert.equal(ago(59), 'just now')
  assert.equal(ago(60), '1 min ago')
  assert.equal(ago(3599), '59 min ago')
  assert.equal(ago(3600), '1 h ago')
  assert.equal(ago(86399), '23 h ago')
  assert.equal(ago(86400), '1 d ago')
  assert.equal(ago(7 * 86400), '1 w ago')
  assert.equal(ago(30 * 86400), '1 mo ago')
  assert.equal(ago(365 * 86400), '1 y ago')
})

test('a time in the future reads as just now', () => {
  assert.equal(formatAge(now + 5000, now), 'just now')
})

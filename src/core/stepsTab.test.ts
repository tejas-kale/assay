import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkLine, rowsLabel, stepsKey } from './stepsTab.ts'

test('a check line is dimmed, passed or failed', () => {
  assert.deepEqual(checkLine({ kind: 'unchecked', ok: false }), { className: 'dim', mark: '·' })
  assert.deepEqual(checkLine({ kind: 'grain', ok: true }), { className: 'check-ok', mark: '✓' })
  assert.deepEqual(checkLine({ kind: 'join', ok: false }), { className: 'check-bad', mark: '✗' })
})

test('rows are counted in the singular for one', () => {
  assert.equal(rowsLabel(1), '1 row')
  assert.equal(rowsLabel(0), '0 rows')
  assert.equal(rowsLabel(12), '12 rows')
})

test('keys map to Steps commands', () => {
  assert.deepEqual(['c', 'p', ',', '.', 'j', 'k', 'r'].map(stepsKey), ['code', 'pin', 'previousRun', 'nextRun', 'down', 'up', 'rerun'])
  assert.equal(stepsKey('x'), undefined)
  assert.equal(stepsKey('constructor'), undefined)
})

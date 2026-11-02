import assert from 'node:assert/strict'
import { test } from 'node:test'

import { markTabs } from './dataTabs.ts'
import type { Seen } from './dataTabs.ts'

const seen = (over: Partial<Seen> = {}): Seen => ({ number: 1, code: '001_a.sql', data: '001_a.csv', failed: false, runCount: 1, plots: [], ...over })
const none = new Set<'data' | 'code' | 'history' | 'plots'>()

test('a new run marks Data, Code and History, except the tab on screen', () => {
  const after = seen({ number: 2, code: '002_b.sql', data: '002_b.csv', runCount: 2 })
  assert.deepEqual([...markTabs(none, seen(), after, 'plots')].sort(), ['code', 'data', 'history'])
  assert.deepEqual([...markTabs(none, seen(), after, 'data')].sort(), ['code', 'history'])
})

test('a result arriving for the same run marks Data only', () => {
  const before = seen({ data: undefined })
  assert.deepEqual([...markTabs(none, before, seen(), 'code')], ['data'])
})

test('a failure marks Data', () => {
  assert.deepEqual([...markTabs(none, seen(), seen({ failed: true }), 'history')], ['data'])
})

test('an unchanged snapshot keeps the markers it had, and showing a tab clears its marker', () => {
  const held = new Set<'data' | 'code' | 'history' | 'plots'>(['data', 'history'])
  assert.deepEqual([...markTabs(held, seen(), seen(), 'code')].sort(), ['data', 'history'])
  assert.deepEqual([...markTabs(held, seen(), seen(), 'data')], ['history'])
})

test('a shrinking run count does not mark History', () => {
  assert.deepEqual([...markTabs(none, seen({ runCount: 3 }), seen({ runCount: 2 }), 'data')], [])
})

test('markTabs does not change the set it was given', () => {
  const held = new Set<'data' | 'code' | 'history' | 'plots'>()
  markTabs(held, seen(), seen({ runCount: 2 }), 'data')
  assert.equal(held.size, 0)
})

test('plots changing for the current run marks Plots, unless Plots is on screen', () => {
  const after = seen({ plots: ['001_a.p1.png'] })
  assert.deepEqual([...markTabs(none, seen(), after, 'data')], ['plots'])
  assert.deepEqual([...markTabs(none, seen(), after, 'plots')], [])
  assert.deepEqual([...markTabs(none, after, after, 'data')], [])
  assert.deepEqual([...markTabs(none, after, seen({ plots: ['001_a.p1.png', '001_a.p2.png'] }), 'code')], ['plots'])
})

test('a changed trust review marks Trust, except while it is shown', () => {
  const after = seen({ trust: '100:asking:3' })
  assert.deepEqual([...markTabs(none, seen({ trust: '100:checking:1' }), after, 'data')], ['trust'])
  assert.deepEqual([...markTabs(none, seen({ trust: '100:checking:1' }), after, 'trust')], [])
  assert.deepEqual([...markTabs(none, seen(), seen(), 'data')], [])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { overviewHeading, overviewKey, overviewShown, segmentText } from './overviewView.ts'

const doc = (text: string) => ({ path: 'p', text })

test('segments read as plain text', () => {
  assert.equal(segmentText({ type: 'text', text: 'a' }), 'a')
  assert.equal(segmentText({ type: 'link', id: '20260101T000000', label: 'Lbl' }), 'Lbl')
  assert.equal(segmentText({ type: 'link', id: '20260101T000000' }), '[[20260101T000000]]')
  assert.equal(segmentText({ type: 'citation', analysis: 'x', number: 7 }), '[x q 007]')
})

test('the analysis side shows its document or says there is none', () => {
  assert.deepEqual(overviewShown({ analysis: doc('a') }, 'analysis', 's'), { doc: doc('a') })
  assert.deepEqual(overviewShown({}, 'analysis', 's'), { missing: 'No overview yet: analyses/s/overview.md' })
})

test('the system side needs the analysis overview, a named system and its file', () => {
  assert.deepEqual(overviewShown({}, 'system', 's'), { missing: 'No overview yet: analyses/s/overview.md' })
  assert.match(overviewShown({ analysis: doc('a') }, 'system', 's').missing ?? '', /No system named/)
  assert.deepEqual(overviewShown({ analysis: doc('a'), system: 'systems/x.md' }, 'system', 's'), { missing: 'No file systems/x.md' })
  assert.deepEqual(overviewShown({ analysis: doc('a'), system: 'systems/x.md', systemDoc: doc('b') }, 'system', 's'), { doc: doc('b') })
})

test('the heading names the system without folder and extension', () => {
  assert.equal(overviewHeading('analysis', 'systems/x.md'), 'Analysis')
  assert.equal(overviewHeading('system', 'systems/x.md'), 'System: x')
  assert.equal(overviewHeading('system', undefined), 'System: —')
})

test('only the Overview keys map to commands', () => {
  assert.equal(overviewKey('s'), 'toggleWhich')
  assert.equal(overviewKey('d'), 'toggleDiff')
  assert.equal(overviewKey('m'), 'markRead')
  assert.equal(overviewKey('j'), 'down')
  assert.equal(overviewKey('k'), 'up')
  assert.equal(overviewKey('g'), 'top')
  assert.equal(overviewKey('G'), 'bottom')
  assert.equal(overviewKey('x'), undefined)
  assert.equal(overviewKey('toString'), undefined)
})

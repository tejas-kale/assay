import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TrustReview } from './trust.ts'
import { checkPlan, mayAnswer, movedProposal, settledKey, trustTabKey } from './trustTab.ts'

const review = (state: TrustReview['state']): TrustReview => ({ name: 'calc', kind: 'calculation', what: 'w', replaces: false, state, startedAt: 5, steps: [] })

test('keys map to the tab commands', () => {
  const keys = ['j', 'k', 'g', 'G', 'J', 'ArrowDown', 'K', 'ArrowUp', 'c', 'Enter', 't', 'r', 'l']
  assert.deepEqual(keys.map(trustTabKey), ['down', 'up', 'top', 'bottom', 'next', 'next', 'previous', 'previous', 'check', 'check', 'trust', 'reject', 'list'])
  assert.equal(trustTabKey('x'), undefined)
  assert.equal(trustTabKey('valueOf'), undefined)
})

test('the selection stays inside the proposals', () => {
  assert.equal(movedProposal(0, 1, 3), 1)
  assert.equal(movedProposal(2, 1, 3), 2)
  assert.equal(movedProposal(0, 1, undefined), 0)
  assert.equal(movedProposal(0, -1, 3), 0)
  assert.equal(movedProposal(2, -1, 3), 1)
})

test('Check goes ahead, waits for an active review, or does nothing while sending', () => {
  assert.deepEqual(checkPlan(undefined, false), { do: 'check' })
  assert.deepEqual(checkPlan(review('failed'), false), { do: 'check' })
  assert.deepEqual(checkPlan(undefined, true), { do: 'nothing' })
  assert.deepEqual(checkPlan(review('checking'), false), { do: 'wait', message: 'Wait for the review of calc to finish.' })
})

test('Trust and Reject need an asking review and no request on its way', () => {
  assert.equal(mayAnswer(review('asking'), false), true)
  assert.equal(mayAnswer(review('asking'), true), false)
  assert.equal(mayAnswer(review('failed'), false), false)
  assert.equal(mayAnswer(undefined, false), false)
})

test('the settled key is empty until a review has ended', () => {
  assert.equal(settledKey(undefined), '')
  assert.equal(settledKey(review('checking')), '')
  assert.equal(settledKey(review('asking')), '')
  assert.equal(settledKey(review('approved')), 'calc:approved:5')
})

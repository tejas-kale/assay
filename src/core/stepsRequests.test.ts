import assert from 'node:assert/strict'
import { test } from 'node:test'

import { accepted, asking, nextRequest, noRequests, pickupTimedOut, refused, replied } from './stepsRequests.ts'

test('a run is asked once: nothing is sent for it again while asked, or when nothing is needed', () => {
  assert.equal(nextRequest(noRequests, 4, 'steps'), 'steps')
  assert.equal(nextRequest(noRequests, 4, 'lineage'), 'lineage')
  assert.equal(nextRequest(noRequests, 4, undefined), undefined)
  const asked = asking(noRequests, 4)
  assert.equal(nextRequest(asked, 4, 'steps'), undefined)
  assert.equal(nextRequest(asked, 5, 'steps'), 'steps')
  assert.equal(noRequests.asked.size, 0)
})

test('a refused request lets the run be asked again', () => {
  assert.equal(nextRequest(refused(asking(noRequests, 4), 4), 4, 'steps'), 'steps')
})

test('a reply to our request reads the run; one to another request is ignored', () => {
  const state = accepted(asking(noRequests, 4), 'a1', 4)
  assert.equal(replied(state, 'zz', { ok: true }).do, 'ignore')
  const got = replied(state, 'a1', { ok: true })
  assert.deepEqual([got.do, 'run' in got && got.run, got.state.pending.size], ['reload', 4, 0])
  assert.equal(nextRequest(got.state, 4, 'steps'), undefined)
})

test('an error reply is shown and the run is asked again next time', () => {
  const got = replied(accepted(asking(noRequests, 4), 'a1', 4), 'a1', { error: 'no such run' })
  assert.deepEqual(got.do, { toast: 'no such run' })
  assert.equal(nextRequest(got.state, 4, 'steps'), 'steps')
})

test('no reply in time with no file makes the run silent and askable again', () => {
  const state = accepted(asking(noRequests, 4), 'a1', 4)
  const got = pickupTimedOut(state, 'a1', false)
  assert.equal(got.silent, 4)
  assert.equal(got.state.pending.has('a1'), false)
  assert.equal(nextRequest(got.state, 4, 'steps'), 'steps')
})

test('a run with a file is not silent: it keeps waiting, and a request already answered is not timed out', () => {
  const state = accepted(asking(noRequests, 4), 'a1', 4)
  const waiting = pickupTimedOut(state, 'a1', true)
  assert.equal(waiting.silent, undefined)
  assert.equal(waiting.state.pending.has('a1'), true)
  assert.equal(pickupTimedOut(replied(state, 'a1', {}).state, 'a1', false).silent, undefined)
})

test('asking again (r) is allowed for a run already asked, and marks it asked', () => {
  const again = asking(asking(noRequests, 4), 4)
  assert.equal(nextRequest(again, 4, 'steps'), undefined)
})

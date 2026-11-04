import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canAnswer, canCheck, earlierReview, outcomeWord, TRUST_STATES, diffLines, isActive, latestReview, parseTrustReview, stateLine, stateTone, stepDetail, stepTitle, trustSeenKey, justAnswered, justFailed, failedMessage } from './trust.ts'

const base = {
  name: 'c',
  kind: 'calculation',
  what: 'SQL template',
  language: 'sql',
  replaces: false,
  state: 'checking',
  startedAt: 100,
}

test('a minimal review parses; optional fields stay absent', () => {
  const r = parseTrustReview(JSON.stringify({ ...base, steps: [] }))
  assert.deepEqual(r, { ...base, steps: [] })
})

test('garbage, wrong shapes and unknown states give undefined', () => {
  assert.equal(parseTrustReview('nope'), undefined)
  assert.equal(parseTrustReview('[]'), undefined)
  assert.equal(parseTrustReview(JSON.stringify({ ...base, state: 'weird' })), undefined)
  assert.equal(parseTrustReview(JSON.stringify({ ...base, startedAt: 'x' })), undefined)
  assert.equal(parseTrustReview(JSON.stringify({ ...base, name: '' })), undefined)
})

test('unknown fields are ignored, bad steps dropped, bad language becomes absent', () => {
  const r = parseTrustReview(
    JSON.stringify({
      ...base,
      extra: 1,
      language: 'cobol',
      steps: [{ step: 'test', ok: false, text: 'FAILED x', name: 'case 2', diff: '- a\n+ b' }, { step: 'test' }, 3, { step: 'form', ok: true, text: 7 }],
      sample: { columns: ['a'], rows: [['1'], 5], total: 12 },
      message: 'm',
      endedAt: 5,
      description: 'd',
      code: 'select 1',
    }),
  )
  assert.ok(r)
  assert.equal('extra' in r, false)
  assert.equal(r.language, undefined)
  assert.deepEqual(r.steps, [
    { step: 'test', ok: false, text: 'FAILED x', name: 'case 2', diff: '- a\n+ b' },
    { step: 'form', ok: true, text: '' },
  ])
  assert.deepEqual(r.sample, { columns: ['a'], rows: [['1']], total: 12 })
  assert.equal(r.message, 'm')
  assert.equal(r.endedAt, 5)
})

test('latestReview picks the largest startedAt', () => {
  const a = parseTrustReview(JSON.stringify({ ...base, name: 'a', startedAt: 5 }))!
  const b = parseTrustReview(JSON.stringify({ ...base, name: 'b', startedAt: 9 }))!
  assert.equal(latestReview([a, b, a])?.name, 'b')
  assert.equal(latestReview([]), undefined)
})

test('stepTitle', () => {
  assert.equal(stepTitle({ step: 'test', ok: true, text: 'PASSED', name: 'case 2' }), 'test case 2')
  assert.equal(stepTitle({ step: 'test', ok: true, text: 'PASSED', name: 'test_x.py::test_y' }), 'test test_x.py::test_y')
  assert.equal(stepTitle({ step: 'transpile', ok: true, text: '' }), 'transpile')
  assert.equal(stepTitle({ step: 'transpile', ok: true, text: '', name: 'x' }), 'transpile')
  assert.equal(stepTitle({ step: 'test', ok: true, text: '' }), 'test')
})

test('stepDetail drops the PASSED/FAILED the line already shows', () => {
  assert.equal(stepDetail({ step: 'test', ok: true, text: 'PASSED' }), '')
  assert.equal(stepDetail({ step: 'test', ok: false, text: 'FAILED assert 1 == 2' }), 'assert 1 == 2')
  assert.equal(stepDetail({ step: 'form', ok: true, text: 'SQL template, 2 parameters' }), 'SQL template, 2 parameters')
})

test('stateTone and isActive', () => {
  assert.equal(stateTone('approved'), 'good')
  assert.equal(stateTone('unchanged'), 'good')
  assert.equal(stateTone('rejected'), 'warn')
  assert.equal(stateTone('failed'), 'warn')
  assert.equal(stateTone('error'), 'bad')
  assert.equal(stateTone('checking'), 'dim')
  assert.equal(isActive('checking'), true)
  assert.equal(isActive('asking'), true)
  assert.equal(isActive('approved'), false)
})

test('stateLine ticks while checking, asks for Trust or Reject, else shows the message', () => {
  const r = parseTrustReview(JSON.stringify({ ...base, steps: [], message: 'Trusted c: committed in trusted/.' }))!
  assert.deepEqual(stateLine(r, 4100), { text: 'checking… 4 s', tone: 'dim' })
  assert.equal(stateLine({ ...r, state: 'asking' }, 9000).text, 'Every check passed: Trust (t) or Reject (r).')
  assert.deepEqual(stateLine({ ...r, state: 'approved' }, 9000), { text: 'Trusted c: committed in trusted/.', tone: 'good' })
})

test('diffLines tags by the first characters', () => {
  assert.deepEqual(diffLines('a,b\n- 1,2\n+ 1,3\n  4,5'), [
    { kind: 'same', text: 'a,b' },
    { kind: 'del', text: '- 1,2' },
    { kind: 'add', text: '+ 1,3' },
    { kind: 'same', text: '  4,5' },
  ])
})

test('trustSeenKey changes with the start, state, step count and sample rows', () => {
  const r = parseTrustReview(JSON.stringify({ ...base, steps: [{ step: 'a', ok: true, text: '' }], sample: { columns: ['a'], rows: [['1'], ['2']] } }))!
  assert.equal(trustSeenKey(r), `${r.startedAt}:${r.state}:1:2`)
  assert.notEqual(trustSeenKey(r), trustSeenKey({ ...r, state: 'approved' }))
  assert.equal(trustSeenKey({ ...r, steps: [] }).split(':')[2], '0')
  const { sample: _drop, ...bare } = r
  assert.equal(trustSeenKey(bare).split(':')[3], '0')
})

test('Trust and Reject are offered only while asking; Check only when no review is open', () => {
  const r = { name: 'c', kind: 'calculation' as const, what: 'SQL template', replaces: false, startedAt: 0, steps: [] }
  assert.equal(canAnswer(undefined), false)
  assert.equal(canCheck(undefined), true)
  for (const state of TRUST_STATES) {
    assert.equal(canAnswer({ ...r, state }), state === 'asking')
    assert.equal(canCheck({ ...r, state }), state !== 'checking' && state !== 'asking')
  }
})

test('earlierReview: a settled review of a name no longer proposed is an earlier one', () => {
  const review = parseTrustReview(JSON.stringify(base))
  assert.ok(review)
  const at = (state: (typeof TRUST_STATES)[number], name = 'old') => ({ ...review, name, state })
  const proposals = [{ name: 'new_one' }]
  assert.equal(earlierReview(at('approved'), proposals), true)
  assert.equal(earlierReview(at('rejected'), proposals), true)
  assert.equal(earlierReview(at('approved', 'new_one'), proposals), false)
  // Running or waiting for an answer: always the current review.
  assert.equal(earlierReview(at('checking'), proposals), false)
  assert.equal(earlierReview(at('asking'), proposals), false)
  // The list has not come back yet: nothing to compare with.
  assert.equal(earlierReview(at('approved'), undefined), false)
  assert.equal(earlierReview(undefined, proposals), false)
})

test('outcomeWord says what became of a settled review', () => {
  assert.equal(outcomeWord('approved'), 'trusted')
  assert.equal(outcomeWord('unchanged'), 'already trusted, unchanged')
  assert.equal(outcomeWord('rejected'), 'rejected')
  assert.equal(outcomeWord('failed'), 'failed its checks')
  assert.equal(outcomeWord('error'), 'stopped with an error')
})

test('justAnswered: the same review moved from asking to trusted or rejected', () => {
  const asking = parseTrustReview(JSON.stringify({ ...base, state: 'asking' }))
  const at = (state: string, startedAt = 100) => parseTrustReview(JSON.stringify({ ...base, state, startedAt }))
  assert.equal(justAnswered(asking, at('approved')), 'trusted')
  assert.equal(justAnswered(asking, at('unchanged')), 'trusted')
  assert.equal(justAnswered(asking, at('rejected')), 'rejected')
  assert.equal(justAnswered(asking, at('error')), undefined)
  assert.equal(justAnswered(asking, at('asking')), undefined)
  // A review first seen already answered (window opened later) or another review: not an answer just given.
  assert.equal(justAnswered(undefined, at('approved')), undefined)
  assert.equal(justAnswered(at('checking'), at('rejected')), undefined)
  assert.equal(justAnswered(asking, at('approved', 200)), undefined)
  assert.equal(justAnswered(asking, undefined), undefined)
})

test('justFailed: a check that ended failed or error since the window last looked', () => {
  const at = (state: string, startedAt = 100) => parseTrustReview(JSON.stringify({ ...base, state, startedAt }))
  assert.equal(justFailed(at('checking'), at('failed')), true)
  assert.equal(justFailed(at('checking'), at('error')), true)
  assert.equal(justFailed(null, at('failed')), true)
  assert.equal(justFailed(at('approved', 50), at('failed')), true)
  assert.equal(justFailed(at('checking'), at('asking')), false)
  // Before the first look, or the same failure seen again: old news.
  assert.equal(justFailed(undefined, at('failed')), false)
  assert.equal(justFailed(at('failed'), at('failed')), false)
})

test('failedMessage: the failed steps on one line, the review file, one Enter at the end', () => {
  const review = parseTrustReview(JSON.stringify({
    ...base,
    state: 'failed',
    steps: [
      { step: 'transpile', ok: true, text: 'PASSED' },
      { step: 'test', name: 'case 2', ok: false, text: 'FAILED expected 3 rows\ngot 2', diff: '- a\n+ b' },
    ],
  }))!
  const text = failedMessage(review)
  assert.match(text, /^The Trust tab check of c failed: test case 2: expected 3 rows got 2\. /)
  assert.match(text, /\.assay\/trust\/c\.json/)
  assert.equal(text.indexOf('\r'), text.length - 1)
  assert.doesNotMatch(text.slice(0, -1), /[\n\r]/)
  const broke = failedMessage({ ...review, state: 'error', steps: [], message: 'x'.repeat(2000) })
  assert.match(broke, /^The Trust tab check of c broke: x+…\. /)
})

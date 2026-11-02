import assert from 'node:assert/strict'
import { test } from 'node:test'

import { diffLines, isActive, latestReview, parseTrustReview, stateLine, stateTone, stepDetail, stepTitle } from './trust.ts'

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

test('stateLine ticks while checking, points at Claude while asking, else shows the message', () => {
  const r = parseTrustReview(JSON.stringify({ ...base, steps: [], message: 'Trusted c: committed in trusted/.' }))!
  assert.deepEqual(stateLine(r, 4100), { text: 'checking… 4 s', tone: 'dim' })
  assert.equal(stateLine({ ...r, state: 'asking' }, 9000).text, 'Answer in the Claude pane (⌘1)')
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

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canRerun, interruptRequest, newRequestId, parseReply, parseRunRequest, pythonRequest, replayRequest, requestText, restartRequest, sqlRequest } from './requests.ts'

test('newRequestId is 13 digits of time, a dash and 6 random [a-z0-9], so names sort by time', () => {
  const id = newRequestId(1_700_000_000_123, () => 0)
  assert.equal(id, '1700000000123-aaaaaa')
  assert.match(newRequestId(5, Math.random), /^0000000000005-[a-z0-9]{6}$/)
  assert.ok(newRequestId(1000, () => 0.5) < newRequestId(2000, () => 0.5))
  assert.match(newRequestId(1, () => 0.9999999), /^0000000000001-[a-z0-9]{6}$/)
})

test('sqlRequest writes the contract body and leaves out an absent origin', () => {
  const text = sqlRequest({ id: 'x-1', sql: 'select 1', engine: 'postgres', from: 12, slug: 'orders' })
  assert.deepEqual(JSON.parse(text), { id: 'x-1', kind: 'sql', sql: 'select 1', engine: 'postgres', from: 12, slug: 'orders' })
  assert.deepEqual(JSON.parse(sqlRequest({ id: 'x-2', sql: 'select 2', engine: 'databricks' })), {
    id: 'x-2',
    kind: 'sql',
    sql: 'select 2',
    engine: 'databricks',
  })
})

test('sqlRequest refuses empty SQL', () => {
  assert.throws(() => sqlRequest({ id: 'x', sql: '  \n', engine: 'databricks' }), /empty/i)
})

test('parseReply reads a number or an error and shrugs off anything else', () => {
  assert.deepEqual(parseReply('{"id":"a","number":13}'), { id: 'a', number: 13 })
  assert.deepEqual(parseReply('{"id":"a","error":"empty SQL"}'), { id: 'a', error: 'empty SQL' })
  for (const junk of ['', 'nope', '[]', '{"id":"a"}', '{"number":1}', '{"id":1,"number":1}']) {
    assert.equal(parseReply(junk), undefined, junk)
  }
})

test('pythonRequest writes the contract body and leaves out an absent origin', () => {
  assert.deepEqual(JSON.parse(pythonRequest({ id: 'p-1', code: 'x = 1', from: 12, slug: 'orders' })), {
    id: 'p-1', kind: 'python', code: 'x = 1', from: 12, slug: 'orders',
  })
  assert.deepEqual(JSON.parse(pythonRequest({ id: 'p-2', code: 'x = 1' })), { id: 'p-2', kind: 'python', code: 'x = 1' })
  assert.throws(() => pythonRequest({ id: 'p', code: ' \n' }), /empty/i)
})

test('interrupt, restart and replay requests', () => {
  assert.deepEqual(JSON.parse(interruptRequest('i-1')), { id: 'i-1', kind: 'interrupt' })
  assert.deepEqual(JSON.parse(restartRequest('r-1')), { id: 'r-1', kind: 'restart' })
  assert.deepEqual(JSON.parse(replayRequest('y-1', [12, 14, 15])), { id: 'y-1', kind: 'replay', runs: [12, 14, 15] })
  assert.throws(() => replayRequest('y', []), /no runs/i)
})

test('requestText writes each kind with the id', () => {
  assert.deepEqual(JSON.parse(requestText('a', { kind: 'python', code: 'x', from: 3 })), { id: 'a', kind: 'python', code: 'x', from: 3 })
  assert.deepEqual(JSON.parse(requestText('a', { kind: 'sql', sql: 'select 1', engine: 'postgres' })), { id: 'a', kind: 'sql', sql: 'select 1', engine: 'postgres' })
  assert.deepEqual(JSON.parse(requestText('a', { kind: 'replay', runs: [1] })), { id: 'a', kind: 'replay', runs: [1] })
  assert.deepEqual(JSON.parse(requestText('a', { kind: 'interrupt' })), { id: 'a', kind: 'interrupt' })
})

test('parseReply reads ok replies', () => {
  assert.deepEqual(parseReply('{"id":"a","ok":true}'), { id: 'a', ok: true })
  assert.equal(parseReply('{"id":"a","ok":false}'), undefined)
})

test('canRerun allows SQL and Python runs, and refuses a trusted Python calculation with the reason', () => {
  const header = { author: 'claude', engine: 'databricks' } as const
  const sql = { number: 1, label: '001', slug: 'a', code: '001_a.sql', language: 'sql', tables: [], plots: [] } as const
  assert.equal(canRerun(sql, header), undefined)
  assert.equal(canRerun({ ...sql, language: 'python' }, header), undefined)
  assert.equal(
    canRerun(sql, { ...header, trusted: 'w' }, '-- python: weekly.py\n'),
    "Run a trusted calculation with Claude's trusted tool",
  )
  assert.equal(canRerun(sql, { ...header, trusted: 'w' }, 'select 1'), undefined)
})

test('parseRunRequest accepts each kind and keeps only the known fields', () => {
  assert.deepEqual(parseRunRequest({ kind: 'interrupt', junk: 1 }), { kind: 'interrupt' })
  assert.deepEqual(parseRunRequest({ kind: 'restart' }), { kind: 'restart' })
  assert.deepEqual(parseRunRequest({ kind: 'replay', runs: [1, 2] }), { kind: 'replay', runs: [1, 2] })
  assert.deepEqual(parseRunRequest({ kind: 'python', code: 'x=1', from: 3, slug: 's', sql: 'no' }), { kind: 'python', code: 'x=1', from: 3, slug: 's' })
  assert.deepEqual(parseRunRequest({ kind: 'sql', sql: 'select 1', engine: 'postgres' }), { kind: 'sql', sql: 'select 1', engine: 'postgres' })
})

test('parseRunRequest refuses bad input with a reason', () => {
  const err = (input: unknown) => (parseRunRequest(input) as { error: string }).error
  assert.equal(err(null), 'Invalid request')
  assert.equal(err({ kind: 'nope' }), 'Invalid request')
  assert.equal(err({ kind: 'replay', runs: [] }), 'Invalid runs')
  assert.equal(err({ kind: 'replay', runs: [-1] }), 'Invalid runs')
  assert.equal(err({ kind: 'replay', runs: Array.from({ length: 501 }, (_, i) => i) }), 'Invalid runs')
  assert.equal(err({ kind: 'python', code: 1 }), 'Invalid code')
  assert.equal(err({ kind: 'python', code: ' \n' }), 'The code is empty')
  assert.equal(err({ kind: 'python', code: 'x', from: 1.5 }), 'Invalid origin')
  assert.equal(err({ kind: 'python', code: 'x', slug: 'a'.repeat(201) }), 'Invalid slug')
  assert.equal(err({ kind: 'sql', sql: '', engine: 'postgres' }), 'The SQL is empty')
  assert.equal(err({ kind: 'sql', sql: 'x'.repeat((1 << 20) + 1), engine: 'postgres' }), 'Invalid SQL')
  assert.equal(err({ kind: 'sql', sql: 'select 1', engine: 'mysql' }), 'Invalid engine')
})

test('the trust requests are checked and written; a reply may carry the proposals', () => {
  assert.deepEqual(parseRunRequest({ kind: 'trust-list' }), { kind: 'trust-list' })
  assert.deepEqual(parseRunRequest({ kind: 'trust-check', name: 'main.panel.sites' }), { kind: 'trust-check', name: 'main.panel.sites' })
  assert.deepEqual(parseRunRequest({ kind: 'trust-answer', name: 'f', answer: 'reject' }), { kind: 'trust-answer', name: 'f', answer: 'reject' })
  assert.deepEqual(parseRunRequest({ kind: 'trust-check', name: '../x' }), { error: 'Invalid proposal' })
  assert.deepEqual(parseRunRequest({ kind: 'trust-answer', name: 'f', answer: 'yes' }), { error: 'Invalid answer' })
  assert.deepEqual(JSON.parse(requestText('i', { kind: 'trust-answer', name: 'f', answer: 'trust' })), { id: 'i', kind: 'trust-answer', name: 'f', answer: 'trust' })
  assert.deepEqual(parseReply('{"id":"a","proposals":[{"name":"f","kind":"calculation","folder":"lib/trusted"},{"name":3},{"name":"m.p.t","kind":"dictionary"}]}'), {
    id: 'a',
    proposals: [
      { name: 'f', kind: 'calculation', folder: 'lib/trusted' },
      { name: 'm.p.t', kind: 'dictionary', folder: 'lib/dictionaries' },
    ],
  })
})

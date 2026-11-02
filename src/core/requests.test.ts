import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canRerun, interruptRequest, newRequestId, parseReply, pythonRequest, replayRequest, requestText, restartRequest, sqlRequest } from './requests.ts'

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

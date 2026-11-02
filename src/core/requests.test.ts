import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canRerun, newRequestId, parseReply, sqlRequest } from './requests.ts'

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

test('canRerun refuses Python runs and trusted Python calculations, with the reason', () => {
  const header = { author: 'claude', engine: 'databricks' } as const
  const sql = { number: 1, label: '001', slug: 'a', code: '001_a.sql', language: 'sql' } as const
  assert.equal(canRerun(sql, header), undefined)
  assert.equal(canRerun({ ...sql, language: 'python' }, header), 'Python runs need the kernel (slice 3)')
  assert.equal(
    canRerun(sql, { ...header, trusted: 'w' }, '-- python: weekly.py\n'),
    'Python runs need the kernel (slice 3)',
  )
  assert.equal(canRerun(sql, { ...header, trusted: 'w' }, 'select 1'), undefined)
})

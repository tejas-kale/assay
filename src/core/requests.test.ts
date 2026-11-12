import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canRerun, interruptRequest, isUrgent, parseRequestFile, selectedSql, newRequestId, parseReply, parseRunRequest, pythonRequest, replayRequest, requestText, restartRequest, sqlRequest } from './requests.ts'

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
  assert.deepEqual(parseRunRequest({ kind: 'trust-done', name: 'f', outcome: 'rejected' }), { kind: 'trust-done', name: 'f', outcome: 'rejected' })
  // The renderer cannot report an approval, and the old answer request is gone (PI-1).
  assert.deepEqual(parseRunRequest({ kind: 'trust-done', name: 'f', outcome: 'approved' }), { error: 'Invalid outcome' })
  assert.deepEqual(parseRunRequest({ kind: 'trust-answer', name: 'f', answer: 'trust' }), { error: 'Invalid request' })
  assert.deepEqual(parseRunRequest({ kind: 'trust-check', name: '../x' }), { error: 'Invalid proposal' })
  assert.deepEqual(JSON.parse(requestText('i', { kind: 'trust-done', name: 'f', outcome: 'approved', message: 'm' })), { id: 'i', kind: 'trust-done', name: 'f', outcome: 'approved', message: 'm' })
  assert.deepEqual(parseReply('{"id":"a","proposals":[{"name":"f","kind":"calculation","folder":"lib/trusted"},{"name":3},{"name":"m.p.t","kind":"dictionary"}]}'), {
    id: 'a',
    proposals: [
      { name: 'f', kind: 'calculation', folder: 'lib/trusted' },
      { name: 'm.p.t', kind: 'dictionary', folder: 'lib/dictionaries' },
    ],
  })
})

test('selectedSql runs selected SQL, refuses other languages and leaves an empty selection alone', () => {
  assert.deepEqual(selectedSql('  select 1\n', 'sql'), { sql: 'select 1' })
  assert.equal(selectedSql('', 'sql'), undefined)
  assert.equal(selectedSql(' \n ', 'python'), undefined)
  assert.deepEqual(selectedSql('print(1)', 'python'), { error: 'Only SQL can be run from a selection.' })
  assert.deepEqual(selectedSql('a: 1', undefined), { error: 'Only SQL can be run from a selection.' })
})

test('the steps request is checked, written, read by the server and queued behind other runs', () => {
  assert.deepEqual(parseRunRequest({ kind: 'steps', run: 12, junk: 1 }), { kind: 'steps', run: 12 })
  assert.deepEqual(parseRunRequest({ kind: 'steps', run: 0 }), { error: 'Invalid run' })
  assert.deepEqual(JSON.parse(requestText('i', { kind: 'steps', run: 3 })), { id: 'i', kind: 'steps', run: 3 })
  assert.deepEqual(parseRequestFile('{"kind":"steps","run":3}'), { kind: 'steps', run: 3 })
  assert.deepEqual(parseRequestFile('{"kind":"steps"}'), { error: 'Name the run, by number.' })
  assert.equal(isUrgent({ kind: 'steps', run: 3 }), false)
})

test('the lineage request is checked, written, read by the server and urgent', () => {
  assert.deepEqual(parseRunRequest({ kind: 'lineage', run: 12, junk: 1 }), { kind: 'lineage', run: 12 })
  assert.deepEqual(parseRunRequest({ kind: 'lineage', run: -1 }), { error: 'Invalid run' })
  assert.deepEqual(parseRunRequest({ kind: 'lineage' }), { error: 'Invalid run' })
  assert.deepEqual(JSON.parse(requestText('i', { kind: 'lineage', run: 3 })), { id: 'i', kind: 'lineage', run: 3 })
  assert.deepEqual(parseRequestFile('{"kind":"lineage","run":3}'), { kind: 'lineage', run: 3 })
  assert.deepEqual(parseRequestFile('{"kind":"lineage","run":0}'), { error: 'Name the run, by number.' })
  assert.equal(isUrgent({ kind: 'lineage', run: 3 }), true)
})

test('a request file is read per kind, with defaults for the engine, the slug and a missing origin', () => {
  assert.deepEqual(parseRequestFile('{"kind":"sql","sql":"select 1"}'), { kind: 'sql', sql: 'select 1', engine: 'databricks', slug: 'query' })
  assert.deepEqual(parseRequestFile('{"kind":"sql","sql":"s","engine":"postgres","from":4,"slug":"orders"}'), { kind: 'sql', sql: 's', engine: 'postgres', from: 4, slug: 'orders' })
  assert.deepEqual(parseRequestFile('{"kind":"sql","sql":"s","from":0,"slug":5}'), { kind: 'sql', sql: 's', engine: 'databricks', slug: 'query' })
  assert.deepEqual(parseRequestFile('{"kind":"python","code":"x=1","from":2,"slug":"s"}'), { kind: 'python', code: 'x=1', from: 2, slug: 's' })
  assert.deepEqual(parseRequestFile('{"kind":"python","code":"x=1"}'), { kind: 'python', code: 'x=1', slug: 'query' })
  assert.deepEqual(parseRequestFile('{"kind":"interrupt"}'), { kind: 'interrupt' })
  assert.deepEqual(parseRequestFile('{"kind":"restart","junk":1}'), { kind: 'restart' })
  assert.deepEqual(parseRequestFile('{"kind":"trust-list"}'), { kind: 'trust-list' })
  assert.deepEqual(parseRequestFile('{"kind":"replay","runs":[1,2]}'), { kind: 'replay', runs: [1, 2] })
})

test('a request file that is wrong says what is missing', () => {
  const err = (text: string) => (parseRequestFile(text) as { error: string }).error
  assert.equal(err('nope'), 'The request is not valid JSON.')
  assert.equal(err('null'), 'The request is not a JSON object.')
  assert.equal(err('5'), 'The request is not a JSON object.')
  assert.equal(err('{"kind":"sql","sql":"  "}'), 'The SQL is empty.')
  assert.equal(err('{"kind":"sql"}'), 'The SQL is empty.')
  assert.equal(err('{"kind":"sql","sql":"s","engine":"mysql"}'), 'Unknown engine: mysql.')
  assert.equal(err('{"kind":"sql","sql":"s","engine":{}}'), 'Unknown engine: [object Object].')
  assert.equal(err('{"kind":"python","code":" "}'), 'The code is empty.')
  assert.equal(err('{"kind":"python"}'), 'The code is empty.')
  assert.equal(err('{"kind":"replay","runs":[]}'), 'Name the runs to replay, by number.')
  assert.equal(err('{"kind":"replay","runs":[1,0]}'), 'Name the runs to replay, by number.')
  assert.equal(err('{"kind":"replay","runs":"1"}'), 'Name the runs to replay, by number.')
  assert.equal(err('{"kind":"nope"}'), 'Unknown request kind: nope.')
  assert.equal(err('{}'), 'Unknown request kind: undefined.')
})

test('a trust request file names its proposal in lower case; trust-done reports an outcome and trust-answer is refused', () => {
  assert.deepEqual(parseRequestFile('{"kind":"trust-check","name":"  Main.Panel "}'), { kind: 'trust-check', name: 'main.panel' })
  assert.deepEqual(parseRequestFile('{"kind":"trust-done","name":"F","outcome":"approved","message":"ok"}'), { kind: 'trust-done', name: 'f', outcome: 'approved', message: 'ok' })
  assert.deepEqual(parseRequestFile('{"kind":"trust-done","name":"f","outcome":"rejected"}'), { kind: 'trust-done', name: 'f', outcome: 'rejected' })
  assert.deepEqual(parseRequestFile('{"kind":"trust-done","name":"f","outcome":"yes"}'), { error: 'The outcome is approved, unchanged or rejected.' })
  assert.deepEqual(parseRequestFile('{"kind":"trust-answer","name":"f","answer":"trust"}'), { error: 'Unknown request kind: trust-answer.' })
  assert.deepEqual(parseRequestFile('{"kind":"trust-check","name":" "}'), { error: 'Name the proposal.' })
  assert.deepEqual(parseRequestFile('{"kind":"trust-done","name":5,"outcome":"approved"}'), { error: 'Name the proposal.' })
})

test('only interrupts, restarts, trust requests and lineage are urgent', () => {
  assert.equal(isUrgent({ kind: 'interrupt' }), true)
  assert.equal(isUrgent({ kind: 'restart' }), true)
  assert.equal(isUrgent({ kind: 'trust-list' }), true)
  assert.equal(isUrgent({ kind: 'sql', sql: 's', engine: 'databricks', slug: 's' }), false)
  assert.equal(isUrgent({ kind: 'python', code: 'c', slug: 's' }), false)
  assert.equal(isUrgent({ kind: 'replay', runs: [1] }), false)
})

test('a run request from the renderer keeps its origin, and a proposal name may be any case with up to three parts', () => {
  assert.deepEqual(parseRunRequest({ kind: 'sql', sql: 's', engine: 'databricks', from: 0, slug: '' }), { kind: 'sql', sql: 's', engine: 'databricks', from: 0, slug: '' })
  assert.deepEqual(parseRunRequest({ kind: 'steps', run: 999_999 }), { kind: 'steps', run: 999_999 })
  assert.deepEqual(parseRunRequest({ kind: 'steps', run: 1_000_000 }), { error: 'Invalid run' })
  assert.deepEqual(parseRunRequest({ kind: 'replay', runs: [0, 999_999] }), { kind: 'replay', runs: [0, 999_999] })
  assert.deepEqual(parseRunRequest({ kind: 'replay', runs: 'x' }), { error: 'Invalid runs' })
  assert.deepEqual(parseRunRequest({ kind: 'sql', sql: 's', engine: 'postgres', slug: 7 }), { error: 'Invalid slug' })
  assert.deepEqual(parseRunRequest({ kind: 'sql', sql: 's', engine: 'postgres', from: -1 }), { error: 'Invalid origin' })
  assert.deepEqual(parseRunRequest({ kind: 'sql', sql: 5, engine: 'postgres' }), { error: 'Invalid SQL' })
  assert.deepEqual(parseRunRequest({ kind: 'python', code: 'x'.repeat((1 << 20) + 1) }), { error: 'Invalid code' })
  for (const name of ['A_1', 'a.b', 'a.b.c', 'a.B_2.c3']) assert.deepEqual(parseRunRequest({ kind: 'trust-check', name }), { kind: 'trust-check', name })
  for (const name of ['1a', 'a.', '.a', 'a.b.c.d', 'a-b', 'a b', 'a.b\n', '', 5]) assert.deepEqual(parseRunRequest({ kind: 'trust-check', name }), { error: 'Invalid proposal' }, String(name))
  assert.deepEqual(parseRunRequest(5), { error: 'Invalid request' })
})

test('newRequestId clamps a random of 1 to the last letter', () => {
  assert.equal(newRequestId(1, () => 1), '0000000000001-999999')
})

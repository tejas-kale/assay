import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addEntry, emptyLedger, isTrustedFile, parseLedger, serializeLedger } from './trustLedger.ts'
import type { LedgerEntry } from './trustLedger.ts'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const entry = (hash: string, file = 'trusted/calc.sql'): LedgerEntry => ({
  kind: 'calculation',
  files: { [file]: hash },
  approvedAt: '2026-11-12T10:00:00.000Z',
  commit: '',
})

test('a file is trusted only when an entry lists its path with its current hash', () => {
  const ledger = addEntry(emptyLedger(), 'calc', entry(A))
  assert.equal(isTrustedFile(ledger, 'trusted/calc.sql', A), true)
  assert.equal(isTrustedFile(ledger, 'trusted/calc.sql', B), false)
  assert.equal(isTrustedFile(ledger, 'trusted/other.sql', A), false)
  assert.equal(isTrustedFile(emptyLedger(), 'trusted/calc.sql', A), false)
})

test('a new approval of the same name replaces the entry and keeps the old one in history', () => {
  const first = addEntry(emptyLedger(), 'calc', entry(A))
  const second = addEntry(first, 'calc', entry(B))
  assert.equal(isTrustedFile(second, 'trusted/calc.sql', A), false)
  assert.equal(isTrustedFile(second, 'trusted/calc.sql', B), true)
  assert.deepEqual(second.history, [{ name: 'calc', ...entry(A) }])
  assert.deepEqual(first.history, [])
})

test('a calculation and a dictionary entry with the same name keep separate entries', () => {
  const dictionary: LedgerEntry = { ...entry(B, 'dictionaries/calc.yaml'), kind: 'dictionary' }
  const ledger = addEntry(addEntry(emptyLedger(), 'calc', entry(A)), 'calc', dictionary)
  assert.equal(isTrustedFile(ledger, 'trusted/calc.sql', A), true)
  assert.equal(isTrustedFile(ledger, 'dictionaries/calc.yaml', B), true)
  assert.deepEqual(ledger.history, [])
})

test('the ledger round-trips through its text', () => {
  const ledger = addEntry(addEntry(emptyLedger(), 'calc', entry(A)), 'calc', entry(B))
  assert.deepEqual(parseLedger(serializeLedger(ledger)), { ledger, problem: undefined })
  assert.ok(serializeLedger(ledger).endsWith('\n'))
})

test('a ledger of the wrong shape parses as empty with a problem, never throwing', () => {
  const bad = [
    'not json',
    '[]',
    'null',
    '{"version":2,"entries":{},"history":[]}',
    '{"version":1,"entries":[],"history":[]}',
    '{"version":1,"entries":{"c":{"kind":"x","files":{},"approvedAt":"t","commit":""}},"history":[]}',
    '{"version":1,"entries":{"c":{"kind":"calculation","files":{"a":"short"},"approvedAt":"t","commit":""}},"history":[]}',
    '{"version":1,"entries":{"c":{"kind":"calculation","files":{},"approvedAt":1,"commit":""}},"history":[]}',
    '{"version":1,"entries":{},"history":[{"kind":"calculation","files":{},"approvedAt":"t","commit":""}]}',
    '{"version":1,"entries":{}}',
  ]
  for (const text of bad) {
    const result = parseLedger(text)
    assert.deepEqual(result.ledger, emptyLedger(), text)
    assert.equal(typeof result.problem, 'string', text)
  }
})

test('names that could reach the prototype are refused', () => {
  const text = '{"version":1,"entries":{"__proto__":{"kind":"calculation","files":{},"approvedAt":"t","commit":""}},"history":[]}'
  assert.equal(typeof parseLedger(text).problem, 'string')
  assert.equal(isTrustedFile(emptyLedger(), '__proto__', A), false)
})

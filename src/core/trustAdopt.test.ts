import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAdoptInput, unadoptedGroups } from './trustAdopt.ts'
import { addEntry, emptyLedger } from './trustLedger.ts'

const h = (c: string) => c.repeat(64)
const file = (name: string, c: string) => ({ name, sha256: h(c) })
const names = (groups: ReturnType<typeof unadoptedGroups>) => groups.map(g => `${g.kind}:${g.name}`)

test('with an empty ledger every calculation and dictionary is a group, with its companions', () => {
  const groups = unadoptedGroups(
    {
      trusted: [file('calc.sql', 'a'), file('test_calc.py', 'b'), file('calc.test.yaml', 'c'), file('calc.rebuild.sql', 'd'), file('other.py', 'e'), file('README.md', 'f')],
      dictionaries: [file('orders.yaml', 'a'), file('orders.test.yaml', 'b'), file('plain.yaml', 'c')],
    },
    emptyLedger(),
  )
  assert.deepEqual(names(groups), ['calculation:calc', 'calculation:other', 'dictionary:orders', 'dictionary:plain'])
  assert.deepEqual(
    groups[0]?.files.map(f => f.name),
    ['calc.rebuild.sql', 'calc.sql', 'calc.test.yaml', 'test_calc.py'],
  )
  assert.deepEqual(groups[2]?.files.map(f => f.name), ['orders.test.yaml', 'orders.yaml'])
})

test('a group is adopted only when every file has a ledger match; one changed file brings it back', () => {
  const ledger = addEntry(emptyLedger(), 'calc', {
    kind: 'calculation',
    files: { 'trusted/calc.sql': h('a'), 'trusted/calc.test.yaml': h('c') },
    approvedAt: 'x',
    commit: '',
  })
  const listing = (test: string) => ({ trusted: [file('calc.sql', 'a'), file('calc.test.yaml', test)], dictionaries: [] })
  assert.deepEqual(unadoptedGroups(listing('c'), ledger), [])
  assert.deepEqual(names(unadoptedGroups(listing('z'), ledger)), ['calculation:calc'])
  assert.deepEqual(names(unadoptedGroups({ trusted: [file('calc.sql', 'a'), file('calc.test.yaml', 'c'), file('new.sql', 'a')], dictionaries: [] }, ledger)), ['calculation:new'])
})

test('a companion without its calculation is a group of its own name, and test_ names follow their calculation', () => {
  assert.deepEqual(names(unadoptedGroups({ trusted: [file('lonely.test.yaml', 'a'), file('foo.sql', 'a'), file('test_foo.py', 'b')], dictionaries: [] }, emptyLedger())), ['calculation:foo', 'calculation:lonely'])
  assert.deepEqual(names(unadoptedGroups({ trusted: [file('test_solo.py', 'a'), file('solo.rebuild.sql', 'b')], dictionaries: [] }, emptyLedger())), ['calculation:solo'])
})

test('dotted names group by the longest primary', () => {
  assert.deepEqual(names(unadoptedGroups({ trusted: [file('a.b.sql', 'a'), file('a.b.test.yaml', 'b')], dictionaries: [file('x.y.yaml', 'a'), file('x.y.test.yaml', 'b')] }, emptyLedger())), ['calculation:a.b', 'dictionary:x.y'])
})

test('a lone dictionary test file is its own group', () => {
  assert.deepEqual(names(unadoptedGroups({ trusted: [], dictionaries: [file('only.test.yaml', 'a')] }, emptyLedger())), ['dictionary:only'])
})

test('adopt input needs a proposal-shaped name, a kind and hashes of that group\'s own files', () => {
  const ok = parseAdoptInput({ name: 'calc', kind: 'calculation', hashes: { 'calc.sql': h('a') } })
  assert.deepEqual(ok, { name: 'calc', kind: 'calculation', hashes: { 'calc.sql': h('a') } })
  assert.deepEqual(parseAdoptInput({ name: 'calc', kind: 'calculation', hashes: { '../x.sql': h('a') } }), { error: '"../x.sql" is not a file this proposal may have.' })
  assert.deepEqual(parseAdoptInput(null), { error: 'Invalid proposal' })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasStructure, lineageMermaid, parseLineage, stepsView } from './lineage.ts'
import type { Lineage } from './lineage.ts'

const LINEAGE: Lineage = {
  nodes: [
    { id: 'orders', kind: 'table', name: 'shop.sales.orders' },
    { id: 'order_lines', kind: 'table', name: 'shop.sales.order_lines' },
    { id: 'daily_spend', kind: 'cte', name: 'daily_spend', grain: ['customer_id', 'order_date'] },
    { id: 'final', kind: 'final', name: 'Final SELECT', grain: [] },
  ],
  edges: [
    { from: 'orders', to: 'daily_spend' },
    { from: 'order_lines', to: 'daily_spend', join: { cardinality: '1:many', keys: ['order_id'] } },
    { from: 'daily_spend', to: 'final' },
  ],
}

test('parseLineage reads a lineage, an error and a note, and drops malformed nodes and edges', () => {
  assert.deepEqual(parseLineage(JSON.stringify({ ...LINEAGE, note: '2 statements' })), { ...LINEAGE, note: '2 statements' })
  assert.deepEqual(parseLineage('{"error":"the SQL does not parse: x"}'), { error: 'the SQL does not parse: x' })
  assert.equal(parseLineage('nope'), undefined)
  assert.equal(parseLineage('{"nodes":3}'), undefined)
  const messy = parseLineage(
    JSON.stringify({
      nodes: [{ id: 'a', kind: 'table', name: 'a' }, { id: 'b', kind: 'weird', name: 'b' }, { kind: 'cte' }, { id: 'c', kind: 'cte', name: 'c', grain: ['x', 3] }, 7],
      edges: [{ from: 'a', to: 'c', join: { cardinality: 'sideways', keys: [] } }, { from: 'a', to: 'zzz' }, { from: 'a' }, { from: 'a', to: 'c', join: { cardinality: '1:1', keys: ['k', 5] } }],
    }),
  )
  assert.deepEqual(messy, {
    nodes: [{ id: 'a', kind: 'table', name: 'a' }, { id: 'c', kind: 'cte', name: 'c', grain: ['x'] }],
    edges: [{ from: 'a', to: 'c', join: {} }, { from: 'a', to: 'c', join: { cardinality: '1:1', keys: ['k'] } }],
  })
})

test('lineageMermaid draws tables as stadiums, CTEs and the final SELECT as boxes, with edge labels', () => {
  assert.equal(
    lineageMermaid(LINEAGE),
    [
      'flowchart LR',
      '  n0(["shop.sales.orders"])',
      '  n1(["shop.sales.order_lines"])',
      '  n2["daily_spend<br/>grain: customer_id, order_date"]',
      '  n3["Final SELECT<br/>grain: one row"]',
      '  n0 --> n2',
      '  n1 -->|"1:many on order_id"| n2',
      '  n2 --> n3',
    ].join('\n'),
  )
})

test('a name with a quote is escaped, a missing grain adds no line, and a join without a line says so', () => {
  const text = lineageMermaid({
    nodes: [{ id: 'a', kind: 'table', name: 'we"ird' }, { id: 'c', kind: 'cte', name: 'c' }],
    edges: [{ from: 'a', to: 'c', join: {} }],
  })
  assert.match(text, /n0\(\["we#quot;ird"\]\)/)
  assert.match(text, /n1\["c"\]/)
  assert.match(text, /n0 -->\|"join: no line"\| n1/)
})

test('edges to unknown nodes are skipped, so the text never names a missing id', () => {
  const text = lineageMermaid({ nodes: [{ id: 'a', kind: 'table', name: 'a' }], edges: [{ from: 'a', to: 'b' }] })
  assert.equal(text, 'flowchart LR\n  n0(["a"])')
})

test('marks add a class per marked node and a classDef per mark used', () => {
  const colors = { good: '#0a0', bad: '#d00', dim: '#888' }
  const text = lineageMermaid(LINEAGE, { 2: 'ok', 3: 'bad', 0: 'skipped', 1: 'running' }, colors)
  assert.match(text, /classDef ok stroke:#0a0/)
  assert.match(text, /classDef bad stroke:#d00/)
  assert.match(text, /classDef running .*stroke-dasharray/)
  assert.match(text, /classDef skipped /)
  assert.match(text, /class n2 ok/)
  assert.match(text, /class n3 bad/)
  assert.doesNotMatch(lineageMermaid(LINEAGE, { 2: 'ok' }, colors), /classDef bad/)
  assert.doesNotMatch(lineageMermaid(LINEAGE), /classDef/)
})

test('hasStructure is false for one table and no join', () => {
  assert.equal(hasStructure(LINEAGE), true)
  assert.equal(hasStructure({ nodes: [{ id: 't', kind: 'table', name: 't' }, { id: 'final', kind: 'final', name: 'Final SELECT' }], edges: [{ from: 't', to: 'final' }] }), false)
  assert.equal(hasStructure({ nodes: [{ id: 't', kind: 'table', name: 't' }, { id: 'final', kind: 'final', name: 'Final SELECT' }], edges: [{ from: 't', to: 'final', join: {} }] }), true)
})

test('stepsView: Python and trusted Python runs read no SQL, a missing file is being read, an error is shown', () => {
  const plain: Lineage = { nodes: [{ id: 't', kind: 'table', name: 't' }, { id: 'final', kind: 'final', name: 'Final SELECT' }], edges: [{ from: 't', to: 'final' }], note: '2 statements' }
  assert.deepEqual(stepsView({ language: 'python' }, 'x = 1', undefined), { kind: 'message', text: 'Steps reads SQL runs.' })
  assert.deepEqual(stepsView({ language: 'sql', trusted: 'w' }, '-- trusted: w\n-- python: w.py\n', LINEAGE), { kind: 'message', text: 'Steps reads SQL runs.' })
  assert.deepEqual(stepsView({ language: 'sql', trusted: 'w' }, '-- trusted: w\nSELECT 1', undefined), { kind: 'reading' })
  assert.deepEqual(stepsView({ language: 'sql' }, 'SELECT 1', { error: 'bad' }), { kind: 'error', error: 'bad' })
  assert.deepEqual(stepsView({ language: 'sql' }, 'SELECT 1', LINEAGE), { kind: 'diagram', lineage: LINEAGE })
  assert.deepEqual(stepsView({ language: 'sql' }, 'SELECT 1', plain), { kind: 'message', text: 'One table, no CTE: nothing to draw.', note: '2 statements' })
})

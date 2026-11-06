import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasStructure, lineageMermaid, mermaidNodeIndex, parseLineage, stepsRequest, stepsView } from './lineage.ts'
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

const PLAN = (steps: object[], over: object = {}) => ({ run: 1, status: 'running' as const, steps, ...over })
const STEP = (k: number, node: number, status: string, checks: object[] = []) => ({ k, name: `s${k}`, node, status, checks })

test('stepsView with a plan carries the plan and the marks for the diagram, and joins the notes', () => {
  const plan = PLAN([STEP(1, 2, 'ok'), STEP(2, 3, 'running')], { note: 'plan note' })
  assert.deepEqual(stepsView({ language: 'sql' }, 'SELECT 1', { ...LINEAGE, note: 'two' }, plan as never), {
    kind: 'diagram',
    lineage: { ...LINEAGE, note: 'two' },
    note: 'two plan note',
    plan,
    marks: { 2: 'ok', 3: 'running' },
  })
  // A plan with no steps is only its note.
  assert.deepEqual(stepsView({ language: 'sql' }, 'SELECT 1', LINEAGE, PLAN([], { status: 'done', note: 'no CTE' }) as never), { kind: 'diagram', lineage: LINEAGE, note: 'no CTE' })
})

test('stepsRequest asks for steps once a SQL run has no steps file, and for lineage only on a trusted run', () => {
  assert.equal(stepsRequest({ language: 'sql' }, 'SELECT 1', undefined, undefined), 'steps')
  assert.equal(stepsRequest({ language: 'sql' }, 'SELECT 1', LINEAGE, undefined), 'steps')
  assert.equal(stepsRequest({ language: 'sql' }, 'SELECT 1', LINEAGE, PLAN([]) as never), undefined)
  assert.equal(stepsRequest({ language: 'python' }, 'x', undefined, undefined), undefined)
  assert.equal(stepsRequest({ language: 'sql', trusted: 'w' }, '-- trusted: w\n-- python: w.py\n', undefined, undefined), undefined)
  assert.equal(stepsRequest({ language: 'sql', trusted: 'w' }, '-- trusted: w\nSELECT 1', undefined, undefined), 'lineage')
  assert.equal(stepsRequest({ language: 'sql', trusted: 'w' }, '-- trusted: w\nSELECT 1', LINEAGE, undefined), undefined)
})

test('mermaidNodeIndex reads our node position from the element id mermaid gives a flowchart node', () => {
  assert.equal(mermaidNodeIndex('flowchart-n3-12'), 3)
  assert.equal(mermaidNodeIndex('flowchart-n0-0'), 0)
  assert.equal(mermaidNodeIndex('flowchart-n12-4'), 12)
  assert.equal(mermaidNodeIndex('mermaid-5'), undefined)
  assert.equal(mermaidNodeIndex('flowchart-nx-1'), undefined)
  assert.equal(mermaidNodeIndex(''), undefined)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripVTControlCharacters as strip } from 'node:util'

import { pickerRows, pickerScreen, pickerStep } from './termPicker.ts'
import type { TermKey, TermPickerState } from './termPicker.ts'

const analyses = [
  { name: 'churn-study-2', title: 'Churn study' },
  { name: 'pricing', title: 'Pricing' },
  { name: 'quarantine-checks', title: 'Quarantine Checks' },
]
const plain = (sequence: string): TermKey => ({ name: sequence, sequence })
const keys = (state: TermPickerState, ...pressed: TermKey[]) => {
  let at = state
  for (const key of pressed) at = pickerStep(analyses, at, key).state
  return at
}

test('rows are the fuzzy matches, then a row creating the typed title unless one has it', () => {
  assert.deepEqual(pickerRows(analyses, '').map(row => row.kind), ['open', 'open', 'open'])
  assert.deepEqual(pickerRows(analyses, 'qchk'), [{ kind: 'open', choice: analyses[2] }, { kind: 'create', title: 'qchk' }])
  assert.deepEqual(pickerRows(analyses, 'Panel churn Q4'), [{ kind: 'create', title: 'Panel churn Q4' }])
  assert.deepEqual(pickerRows(analyses, ' pricing ').map(row => row.kind), ['open'])
  assert.deepEqual(pickerRows(analyses, '!!!'), [])
})

test('typing edits the query and selects the best match; Backspace, Ctrl-W and Ctrl-U delete', () => {
  const start = { query: '', selected: 2 }
  assert.deepEqual(keys(start, plain('p'), plain('r')), { query: 'pr', selected: 0 })
  assert.deepEqual(keys({ query: 'pr', selected: 0 }, { name: 'backspace', sequence: '\x7f' }), { query: 'p', selected: 0 })
  assert.deepEqual(keys({ query: 'churn stu', selected: 0 }, { name: 'w', ctrl: true }), { query: 'churn ', selected: 0 })
  assert.deepEqual(keys({ query: 'churn', selected: 0 }, { name: 'u', ctrl: true }), { query: '', selected: 0 })
  assert.deepEqual(keys(start, { name: 'p', sequence: 'p', meta: true }, { name: 'tab', sequence: '\t' }), start)
})

test('arrows and Ctrl-N/P move within the rows', () => {
  const start = { query: '', selected: 0 }
  assert.equal(keys(start, { name: 'down' }, { name: 'n', ctrl: true }).selected, 2)
  assert.equal(keys(start, { name: 'down' }, { name: 'down' }, { name: 'down' }).selected, 2)
  assert.equal(keys({ query: '', selected: 1 }, { name: 'p', ctrl: true }, { name: 'up' }).selected, 0)
})

test('Enter opens the selected analysis or creates the typed title; nothing to choose does nothing', () => {
  const enter = { name: 'return' }
  assert.deepEqual(pickerStep(analyses, { query: '', selected: 1 }, enter).effect, { do: 'open', name: 'pricing' })
  assert.deepEqual(pickerStep(analyses, { query: 'Panel churn', selected: 0 }, { name: 'enter' }).effect, { do: 'create', title: 'Panel churn' })
  assert.deepEqual(pickerStep(analyses, { query: 'qchk', selected: 9 }, enter).effect, { do: 'create', title: 'qchk' })
  assert.equal(pickerStep(analyses, { query: '!!!', selected: 0 }, enter).effect, undefined)
})

test('Escape, Ctrl-C, and Ctrl-D on an empty query cancel', () => {
  const cancel = { do: 'cancel' }
  assert.deepEqual(pickerStep(analyses, { query: 'x', selected: 0 }, { name: 'escape' }).effect, cancel)
  assert.deepEqual(pickerStep(analyses, { query: 'x', selected: 0 }, { name: 'c', ctrl: true }).effect, cancel)
  assert.deepEqual(pickerStep(analyses, { query: '', selected: 0 }, { name: 'd', ctrl: true }).effect, cancel)
  assert.equal(pickerStep(analyses, { query: 'x', selected: 0 }, { name: 'd', ctrl: true }).effect, undefined)
})

test('the screen shows the query, the rows with the selection marked, a count and a hint', () => {
  const { lines, cursor } = pickerScreen(analyses, { query: 'qchk', selected: 1 }, { columns: 80, rows: 24 })
  assert.deepEqual(lines.slice(0, 3).map(strip), ['Open analysis: qchk', '  Quarantine Checks', '> + New analysis "qchk"'])
  assert.ok(lines[2]?.startsWith('\x1b[7m'))
  assert.match(strip(lines[3] ?? ''), /^1\/3 {2}↑↓ move/)
  assert.equal(cursor, 'Open analysis: qchk'.length)
  assert.equal(strip(pickerScreen(analyses, { query: '', selected: 1 }, { columns: 80, rows: 24 }).lines[1] ?? ''), '  Churn study  churn-study-2')
})

test('a short terminal shows a window that keeps the selection in view, and long text is cut to fit', () => {
  const { lines } = pickerScreen(analyses, { query: '', selected: 2 }, { columns: 80, rows: 5 })
  assert.deepEqual(lines.slice(1, -1).map(strip), ['  Pricing', '> Quarantine Checks'])
  const narrow = pickerScreen(analyses, { query: 'a'.repeat(40), selected: 0 }, { columns: 30, rows: 24 })
  assert.equal(strip(narrow.lines[0] ?? ''), `Open analysis: ${'a'.repeat(14)}`)
  assert.equal(narrow.cursor, 29)
  assert.equal(strip(pickerScreen(analyses, { query: 'chu', selected: 0 }, { columns: 20, rows: 24 }).lines[1] ?? ''), '> Churn study')
})

test('with nothing to show, the screen says how to go on', () => {
  const size = { columns: 80, rows: 24 }
  assert.match(strip(pickerScreen([], { query: '', selected: 0 }, size).lines[1] ?? ''), /No analyses yet\. Type a title/)
  assert.match(strip(pickerScreen([], { query: '!!', selected: 0 }, size).lines[1] ?? ''), /"!!" is no title/)
  assert.ok(!strip(pickerScreen([], { query: '', selected: 0 }, size).lines[2] ?? '').startsWith('0/'))
})

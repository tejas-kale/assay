import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clampTo,
  gridKey,
  headerNote,
  historyKey,
  pickupMissed,
  plotKey,
  replyToast,
  runFiles,
  runKey,
  runNumber,
  seenOf,
  sqlEngine,
  textScroll,
} from './dataPane.ts'
import type { Run } from './runs.ts'

const run = (number: number, more: Partial<Run> = {}): Run => ({
  number,
  label: runNumber(number),
  slug: 'q',
  tables: [],
  plots: [],
  ...more,
})

const shape = { rows: 10, cols: 4, page: 3 }
const at = (row: number, col: number) => ({ row, col })

test('the grid cursor moves with the keys and stops at the edges', () => {
  const move = (key: string, from = at(5, 2)) => gridKey(key, { at: from, rowOpen: false, ...shape })
  assert.deepEqual(move('j'), { kind: 'move', cell: at(6, 2) })
  assert.deepEqual(move('ArrowUp'), { kind: 'move', cell: at(4, 2) })
  assert.deepEqual(move('l'), { kind: 'move', cell: at(5, 3) })
  assert.deepEqual(move('ArrowLeft'), { kind: 'move', cell: at(5, 1) })
  assert.deepEqual(move('J'), { kind: 'move', cell: at(8, 2) })
  assert.deepEqual(move('PageUp'), { kind: 'move', cell: at(2, 2) })
  assert.deepEqual(move('g'), { kind: 'move', cell: at(0, 2) })
  assert.deepEqual(move('G'), { kind: 'move', cell: at(9, 2) })
  assert.deepEqual(move('0'), { kind: 'move', cell: at(5, 0) })
  assert.deepEqual(move('$'), { kind: 'move', cell: at(5, 3) })
  assert.deepEqual(move('j', at(9, 3)), { kind: 'move', cell: at(9, 3) })
  assert.deepEqual(move('h', at(0, 0)), { kind: 'move', cell: at(0, 0) })
  assert.deepEqual(move('Enter'), { kind: 'open', open: true })
  assert.deepEqual(move('y'), { kind: 'copy' })
  assert.equal(move('x'), undefined)
})

test('an open row moves up and down and closes, and takes no other key', () => {
  const press = (key: string) => gridKey(key, { at: at(5, 2), rowOpen: true, ...shape })
  assert.deepEqual(press('j'), { kind: 'move', cell: at(6, 2) })
  assert.deepEqual(press('k'), { kind: 'move', cell: at(4, 2) })
  assert.deepEqual(press('Escape'), { kind: 'open', open: false })
  assert.deepEqual(press('Enter'), { kind: 'open', open: false })
  assert.equal(press('l'), undefined)
  assert.equal(press('y'), undefined)
})

test('the text view scrolls by two lines, a page, or to an end', () => {
  const box = { height: 220, scrollHeight: 900 }
  assert.deepEqual(textScroll('j', box), { by: 44 })
  assert.deepEqual(textScroll('ArrowUp', box), { by: -44 })
  assert.deepEqual(textScroll('PageDown', box), { by: 198 })
  assert.deepEqual(textScroll('K', box), { by: -198 })
  assert.deepEqual(textScroll('g', box), { to: 0 })
  assert.deepEqual(textScroll('G', box), { to: 900 })
  assert.equal(textScroll('x', box), undefined)
})

test('the run keys: c for code, p to pin, comma and period to step', () => {
  assert.deepEqual(runKey('c'), { kind: 'code' })
  assert.deepEqual(runKey('p'), { kind: 'pin' })
  assert.deepEqual(runKey(','), { kind: 'step', delta: -1 })
  assert.deepEqual(runKey('.'), { kind: 'step', delta: 1 })
  assert.equal(runKey('j'), undefined)
})

test('the plot keys step forward and back', () => {
  for (const key of ['j', 'ArrowDown', 'l', 'ArrowRight']) assert.equal(plotKey(key), 1)
  for (const key of ['k', 'ArrowUp', 'h', 'ArrowLeft']) assert.equal(plotKey(key), -1)
  assert.equal(plotKey('x'), undefined)
})

test('History moves its selection, pins and chooses', () => {
  assert.deepEqual(historyKey('j', 2, 5), { kind: 'select', index: 3 })
  assert.deepEqual(historyKey('k', 0, 5), { kind: 'select', index: 0 })
  assert.deepEqual(historyKey('ArrowUp', 2, 5), { kind: 'select', index: 1 })
  assert.deepEqual(historyKey('g', 2, 5), { kind: 'select', index: 0 })
  assert.deepEqual(historyKey('G', 2, 5), { kind: 'select', index: 4 })
  assert.deepEqual(historyKey('p', 2, 5), { kind: 'pin' })
  assert.deepEqual(historyKey('Enter', 2, 5), { kind: 'choose' })
  assert.equal(historyKey('x', 2, 5), undefined)
})

test('a reply is said once: a refused run, or how an interrupt, restart or replay ended', () => {
  assert.equal(replyToast('sql', { id: 'a', error: 'bad' }), 'The run was refused: bad')
  assert.equal(replyToast(undefined, { id: 'a', error: 'bad' }), 'The run was refused: bad')
  assert.equal(replyToast('restart', { id: 'a', error: 'no kernel' }), 'no kernel')
  assert.equal(replyToast('interrupt', { id: 'a', ok: true }), 'Interrupted.')
  assert.equal(replyToast('restart', { id: 'a', ok: true }), 'Kernel restarted.')
  assert.equal(replyToast('replay', { id: 'a', ok: true }), 'Replay finished.')
  assert.equal(replyToast('sql', { id: 'a', ok: true }), undefined)
  assert.equal(replyToast('sql', { id: 'a', number: 3 }), undefined)
})

test('a request was missed when nothing ran, no run came, and no kernel is starting', () => {
  const idle = { failed: {} }
  assert.equal(pickupMissed({ status: idle, runCount: 4 }, 4), true)
  assert.equal(pickupMissed({ status: idle, runCount: 5 }, 4), false)
  assert.equal(pickupMissed({ status: { ...idle, running: { number: 5, startedAt: 0 } }, runCount: 4 }, 4), false)
  assert.equal(pickupMissed({ status: { ...idle, kernel: { state: 'starting' } }, runCount: 4 }, 4), false)
  assert.equal(pickupMissed({ status: { ...idle, kernel: { state: 'idle' } }, runCount: 4 }, 4), true)
})

test('the header note names the table, the plot or the running step', () => {
  const base = { python: true, textView: false, table: { k: 2, count: 3 }, plot: { n: 1, count: 2 }, steps: undefined }
  assert.equal(headerNote({ ...base, tab: 'data' }), 'table 2 of 3')
  assert.equal(headerNote({ ...base, tab: 'data', textView: true }), undefined)
  assert.equal(headerNote({ ...base, tab: 'data', python: false }), undefined)
  assert.equal(headerNote({ ...base, tab: 'data', table: { k: 1, count: 0 } }), undefined)
  assert.equal(headerNote({ ...base, tab: 'plots' }), 'plot 1 of 2')
  assert.equal(headerNote({ ...base, tab: 'plots', plot: { n: 1, count: 0 } }), undefined)
  assert.equal(headerNote({ ...base, tab: 'steps', steps: 'step 2 of 4 running' }), 'step 2 of 4 running')
  assert.equal(headerNote({ ...base, tab: 'steps' }), undefined)
  assert.equal(headerNote({ ...base, tab: 'code' }), undefined)
})

test('History lists the files a run has', () => {
  assert.equal(runFiles(run(1, { code: '001_q.sql', data: '001_q.csv', steps: 1 })), 'sql + csv + 1 step')
  assert.equal(runFiles(run(2, { code: '002_q.py', language: 'python', tables: ['a', 'b'], plots: ['p'] })), 'py + 2 tables + 1 plot')
  assert.equal(runFiles(run(3, { tables: ['a'], plots: ['p', 'q'], steps: 2 })), '2 steps + 1 table + 2 plots')
  assert.equal(runFiles(run(4)), '')
})

test('the marker snapshot reads the current run, its result and the trust review', () => {
  const sql = run(7, { code: '007_q.sql', data: '007_q.csv' })
  assert.deepEqual(seenOf({ current: sql, status: { failed: { 7: 'boom' } }, runCount: 7 }), {
    number: 7,
    code: '007_q.sql',
    data: '007_q.csv',
    plots: [],
    failed: true,
    runCount: 7,
  })
  const python = run(8, { result: '008_q.json', status: 'ok', tables: ['t'], plots: ['p'] })
  assert.deepEqual(seenOf({ current: python, status: { failed: {} }, runCount: 8, trust: 'x' }), {
    number: 8,
    data: 'ok:1',
    plots: ['p'],
    failed: false,
    runCount: 8,
    trust: 'x',
  })
  assert.deepEqual(seenOf({ current: run(9, { result: '009_q.json' }), status: { failed: {} }, runCount: 9 }).data, ':0')
  assert.deepEqual(seenOf({ current: undefined, status: { failed: {} }, runCount: 0 }), { plots: [], failed: false, runCount: 0 })
})

test('small helpers: clamping, run numbers and the engine of a new query', () => {
  assert.equal(clampTo(0, 3), 1)
  assert.equal(clampTo(5, 3), 3)
  assert.equal(clampTo(2, 0), 1)
  assert.equal(runNumber(7), '007')
  assert.equal(runNumber(1234), '1234')
  assert.equal(sqlEngine([run(1, { language: 'sql', engine: 'postgres' }), run(2, { language: 'python' })]), 'postgres')
  assert.equal(sqlEngine([run(1, { language: 'sql' })]), 'databricks')
  assert.equal(sqlEngine([]), 'databricks')
})

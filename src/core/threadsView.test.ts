import assert from 'node:assert/strict'
import { test } from 'node:test'

import { movedSelection, sectionHeading, selectionAfterFold, threadCommand, threadItems, threadPopupText } from './threadsView.ts'

const threads = { open: ['a', 'b'], closed: [{ thread: 'c', outcome: 'done' }, { thread: 'd' }] }

test('closed threads are listed only when unfolded, with their outcome in the filter text', () => {
  assert.deepEqual(threadItems(threads, false).map(i => i.text), ['a', 'b'])
  const all = threadItems(threads, true)
  assert.deepEqual(all.map(i => [i.kind, i.index, i.text]), [['open', 0, 'a'], ['open', 1, 'b'], ['closed', 0, 'c done'], ['closed', 1, 'd']])
})

test('the pop-up shows an open thread, or a closed one with its outcome when it has one', () => {
  const [withOutcome, without] = threadItems(threads, true).filter(i => i.kind === 'closed')
  assert.ok(withOutcome && without)
  assert.equal(threadPopupText({ kind: 'open', index: 0, text: 'a' }), 'a')
  assert.equal(threadPopupText(withOutcome), 'c\n\n→ done')
  assert.equal(threadPopupText(without), 'd')
})

test('letters map to commands', () => {
  assert.equal(threadCommand('a'), 'add')
  assert.equal(threadCommand('z'), 'toggleClosed')
  assert.equal(threadCommand('e'), 'edit')
  assert.equal(threadCommand('c'), 'close')
  assert.equal(threadCommand('d'), 'delete')
  assert.equal(threadCommand('J'), 'moveDown')
  assert.equal(threadCommand('K'), 'moveUp')
  assert.equal(threadCommand('j'), undefined)
  assert.equal(threadCommand('constructor'), undefined)
})

test('a moved thread keeps the selection inside the open threads', () => {
  assert.equal(movedSelection(1, 1, 2), 1)
  assert.equal(movedSelection(0, -1, 2), 0)
  assert.equal(movedSelection(0, 1, 3), 1)
})

test('folding moves a closed selection to the last open thread', () => {
  const closed = threadItems(threads, true).find(i => i.kind === 'closed')
  assert.equal(selectionAfterFold(closed, 2), 1)
  assert.equal(selectionAfterFold(closed, 0), 0)
  assert.equal(selectionAfterFold({ kind: 'open', index: 0, text: 'a' }, 2), undefined)
  assert.equal(selectionAfterFold(undefined, 2), undefined)
})

test('section headings', () => {
  assert.equal(sectionHeading('open', 3), 'Open')
  assert.equal(sectionHeading('closed', 3), 'Closed 3 · z hide')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cycleTarget, editorKey, followTarget, padRunNumber, readerCommand, staleEditMessage } from './noteReader.ts'
import type { CitationLabel } from './citationLabels.ts'
import type { RootNote } from './rootNotes.ts'

const note = (id: string, name: string): RootNote => ({ id, name, title: name, mtimeMs: 0, size: 0 }) as RootNote
const notes = [note('20260101T000000', 'first.md')]
const noContext = { notes, slug: 'mine', labels: new Map<string, CitationLabel>(), runNumbers: [1, 2] }

test('run numbers are padded to three digits', () => {
  assert.equal(padRunNumber(7), '007')
  assert.equal(padRunNumber(1234), '1234')
})

test('reader keys map to commands, Tab by direction', () => {
  assert.equal(readerCommand('Tab', false), 'next-target')
  assert.equal(readerCommand('Tab', true), 'previous-target')
  assert.equal(readerCommand('Enter', false), 'follow')
  assert.equal(readerCommand('Backspace', false), 'back')
  assert.equal(readerCommand('Escape', false), 'leave')
  assert.equal(readerCommand('e', false), 'edit')
  assert.equal(readerCommand('j', false), 'scroll-down')
  assert.equal(readerCommand('k', false), 'scroll-up')
})

test('other keys, even inherited property names, are left alone', () => {
  assert.equal(readerCommand('x', false), undefined)
  assert.equal(readerCommand('constructor', false), undefined)
})

test('Tab wraps around the targets and starts from the first or last', () => {
  assert.equal(cycleTarget(-1, true, 3), 0)
  assert.equal(cycleTarget(2, true, 3), 0)
  assert.equal(cycleTarget(0, false, 3), 2)
  assert.equal(cycleTarget(-1, false, 3), 1)
  assert.equal(cycleTarget(0, true, 1), 0)
})

test('a link opens the note with its id, or says it is missing', () => {
  assert.deepEqual(followTarget({ type: 'link', id: '20260101T000000' }, noContext), { type: 'open-note', name: 'first.md' })
  assert.deepEqual(followTarget({ type: 'link', id: '20250101T000000' }, noContext), { type: 'flash', text: 'No note 20250101T000000' })
})

test('a citation of the open analysis holds its run when the run exists', () => {
  assert.deepEqual(followTarget({ type: 'citation', analysis: 'mine', number: 2 }, noContext), { type: 'show-run', number: 2 })
  assert.deepEqual(followTarget({ type: 'citation', analysis: 'mine', number: 9 }, noContext), { type: 'flash', text: 'No run 009' })
})

test('a citation of another analysis reads that run', () => {
  assert.deepEqual(followTarget({ type: 'citation', analysis: 'other', number: 3 }, noContext), { type: 'read-run', analysis: 'other', number: 3 })
})

test('a citation labelled missing says which run is missing', () => {
  const labels = new Map<string, CitationLabel>([['other q 3', 'missing']])
  const result = followTarget({ type: 'citation', analysis: 'other', number: 3 }, { ...noContext, labels })
  assert.deepEqual(result, { type: 'flash', text: 'No run other q 003' })
})

test('with the discard prompt up, y leaves, n and Esc dismiss it, and every other key is swallowed', () => {
  const k = (key: string) => ({ key, metaKey: false, ctrlKey: false, altKey: false })
  assert.equal(editorKey(k('y'), true, true), 'leave-and-close-prompt')
  assert.equal(editorKey(k('n'), true, false), 'close-prompt')
  assert.equal(editorKey(k('Escape'), true, false), 'close-prompt')
  assert.equal(editorKey(k('x'), true, false), 'none')
})

test('Cmd+S saves, and Esc at rest leaves; anything else is Vim\'s', () => {
  const k = (key: string, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods })
  assert.equal(editorKey(k('s', { metaKey: true }), false, false), 'save')
  assert.equal(editorKey(k('s', { metaKey: true, ctrlKey: true }), false, false), undefined)
  assert.equal(editorKey(k('s', { metaKey: true, altKey: true }), false, false), undefined)
  assert.equal(editorKey(k('s'), false, false), undefined)
  assert.equal(editorKey(k('Escape'), false, true), 'leave-or-ask')
  assert.equal(editorKey(k('Escape'), false, false), undefined)
})

test('the stale-edit message says whether the text was copied', () => {
  assert.match(staleEditMessage(true), /is on the clipboard/)
  assert.match(staleEditMessage(false), /could not be copied/)
})

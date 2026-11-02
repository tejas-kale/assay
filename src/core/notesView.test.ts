import assert from 'node:assert/strict'
import { test } from 'node:test'

import { citationAction, citationText, linkTitle, noteGroups, notesTabLabel } from './notesView.ts'
import type { RootNote } from './rootNotes.ts'

const note = (id: string, title: string): RootNote => ({ name: `${id}-x.md`, id, slug: 'x', title, links: [], citations: [], mtimeMs: 0, size: 0 })
const all = [note('20261001T090000', 'Old'), note('20261102T181500', 'New'), note('20261102T183012', 'Newest')]

test('groups are newest first, skip IDs with no file, and keep a note in one group', () => {
  const groups = noteGroups(all, { written: ['20261001T090000', '20261102T183012', '20269999T000000'], found: ['20261102T181500', '20261001T090000'] })
  assert.deepEqual(groups.written.map(n => n.title), ['Newest', 'Old'])
  assert.deepEqual(groups.found.map(n => n.title), ['New'])
})

test('the tab label carries the count', () => {
  assert.equal(notesTabLabel({ written: [], found: [] }), 'Notes')
  assert.equal(notesTabLabel(noteGroups(all, { written: ['20261001T090000'], found: ['20261102T181500'] })), 'Notes 2')
})

test('a link shows the title; an unknown ID has none', () => {
  assert.equal(linkTitle('20261102T181500', all), 'New')
  assert.equal(linkTitle('20260101T000000', all), undefined)
})

test('a citation names its analysis only when it is another one', () => {
  assert.equal(citationText({ analysis: 'a', number: 3 }, 'a'), 'q 003')
  assert.equal(citationText({ analysis: 'b', number: 3 }, 'a'), 'b q 003')
})

test('following a citation focuses, previews or does nothing', () => {
  const labels = new Map([['a q 1', 'trusted' as const], ['b q 2', 'queried' as const], ['b q 9', 'missing' as const]])
  assert.deepEqual(citationAction({ analysis: 'a', number: 1 }, 'a', labels), { type: 'focus', number: 1 })
  assert.deepEqual(citationAction({ analysis: 'b', number: 2 }, 'a', labels), { type: 'preview', analysis: 'b', number: 2 })
  assert.deepEqual(citationAction({ analysis: 'b', number: 9 }, 'a', labels), { type: 'missing' })
})

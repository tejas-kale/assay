import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StaleEdit } from './errors.ts'
import {
  addFound,
  addWritten,
  freeId,
  idTime,
  inRootNotes,
  noteBlocks,
  noteBody,
  noteFileName,
  noteId,
  noteSegments,
  noteText,
  parseNoteFileName,
  parseNoteLists,
  parseRootNote,
  qualifyCitations,
  removeWritten,
  retitle,
  reviseBody,
  setNoteLists,
} from './rootNotes.ts'

test('noteId is the local time as YYYYMMDDTHHMMSS and idTime reads it back', () => {
  const at = new Date(2026, 10, 2, 18, 15, 0)
  assert.equal(noteId(at), '20261102T181500')
  assert.equal(idTime('20261102T181500').getTime(), at.getTime())
})

test('freeId bumps by one second past taken IDs', () => {
  const at = new Date(2026, 10, 2, 23, 59, 59, 400)
  assert.equal(freeId(at, []), '20261102T235959')
  assert.equal(freeId(at, ['20261102T235959', '20261103T000000']), '20261103T000001')
})

test('file names round trip and nothing else parses', () => {
  const name = noteFileName('20261102T181500', 'Churn by Region!')
  assert.equal(name, '20261102T181500-churn-by-region.md')
  assert.deepEqual(parseNoteFileName(name), { id: '20261102T181500', slug: 'churn-by-region' })
  for (const bad of ['004-churn.md', '20261102-a.md', '20261102T1815-a.md', '20261102T181500-.md', '20261102T181500-A.md', '20261102T181500-a.txt']) {
    assert.equal(parseNoteFileName(bad), undefined, bad)
  }
})

test('noteText writes the title line, a blank line and the trimmed body', () => {
  assert.equal(noteText('  A   title ', '\nbody\n\n'), '# A title\n\nbody\n')
  assert.equal(noteText('Only', '  '), '# Only\n')
  assert.equal(noteBody('# A\n\nbody\n'), 'body\n')
})

test('segments split out links and qualified citations, not bare ones or code', () => {
  const text = 'See [[20261001T090000]] and [churn-q3 q 12]; old [q 3] and [[slug]].\n```\n[[20261001T090000]] [a q 1]\n```\n'
  assert.deepEqual(noteSegments(text), [
    { type: 'text', text: 'See ' },
    { type: 'link', id: '20261001T090000' },
    { type: 'text', text: ' and ' },
    { type: 'citation', analysis: 'churn-q3', number: 12 },
    { type: 'text', text: '; old [q 3] and [[slug]].\n```\n[[20261001T090000]] [a q 1]\n```\n' },
  ])
})

test('a link may carry a label after a bar, which the reader shows instead of the title', () => {
  assert.deepEqual(noteSegments('Drops columns from [[20261006T090118|vw_panel]] and [[20261006T090131| ]].'), [
    { type: 'text', text: 'Drops columns from ' },
    { type: 'link', id: '20261006T090118', label: 'vw_panel' },
    { type: 'text', text: ' and ' },
    { type: 'link', id: '20261006T090131' },
    { type: 'text', text: '.' },
  ])
  assert.deepEqual(parseRootNote('20261102T181500-x.md', '# X\n\n[[20261006T090118|vw_panel]]\n', { mtimeMs: 0, size: 0 })?.links, ['20261006T090118'])
})

test('parseRootNote reads ID, title, links and citations once each', () => {
  const text = '# Churn\n\n[[20261001T090000]] [a q 1] [a q 001] [b q 1] [[20261001T090000]]\n'
  assert.deepEqual(parseRootNote('20261102T181500-churn.md', text, { mtimeMs: 5, size: 9 }), {
    name: '20261102T181500-churn.md',
    id: '20261102T181500',
    slug: 'churn',
    title: 'Churn',
    links: ['20261001T090000'],
    citations: [
      { analysis: 'a', number: 1 },
      { analysis: 'b', number: 1 },
    ],
    mtimeMs: 5,
    size: 9,
  })
  assert.equal(parseRootNote('20261102T181500-churn.md', 'no title', { mtimeMs: 0, size: 0 }).title, 'churn')
})

test('qualifyCitations names the analysis on bare citations outside code', () => {
  assert.equal(qualifyCitations('Rate [q 3], [q 012] and [x q 4]\n```\n[q 9]\n```\n', 'churn'), 'Rate [churn q 3], [churn q 12] and [x q 4]\n```\n[q 9]\n```\n')
})

test('reviseBody replaces exactly once and refuses a missing or repeated old', () => {
  const text = '# T\n\nOne two two three\n'
  assert.equal(reviseBody(text, 'One', 'Uno'), '# T\n\nUno two two three\n')
  assert.throws(() => reviseBody(text, 'four', 'x'), StaleEdit)
  assert.throws(() => reviseBody(text, 'two', 'x'), /more than once/)
  assert.throws(() => reviseBody(text, '', 'x'), /empty/)
  assert.throws(() => reviseBody(text, 'T', 'x'), StaleEdit, 'the title is not part of the body')
  assert.equal(retitle(text, 'New'), '# New\n\nOne two two three\n')
})

test('noteBlocks keeps fenced code apart from paragraphs', () => {
  assert.deepEqual(noteBlocks('## H\n\npara [[20261001T090000]]\n\n```sql\nselect 1\n```\n'), [
    { type: 'heading', level: 2, segments: [{ type: 'text', text: 'H' }] },
    { type: 'paragraph', segments: [{ type: 'text', text: 'para ' }, { type: 'link', id: '20261001T090000' }] },
    { type: 'code', text: 'select 1', lang: 'sql' },
  ])
})

test('the notes lists are added to analysis.yaml and read back', () => {
  const yaml = 'title: Churn\ncreated: 2026-11-02\n'
  const once = addWritten(yaml, '20261102T181500')
  assert.equal(once, 'title: Churn\ncreated: 2026-11-02\nnotes:\n  written: [20261102T181500]\n  found: []\n')
  const twice = addFound(addWritten(once, '20261102T183012'), ['20261001T090000', '20261102T181500'])
  assert.deepEqual(parseNoteLists(twice), { written: ['20261102T181500', '20261102T183012'], found: ['20261001T090000'] })
  assert.deepEqual(parseNoteLists(removeWritten(twice, '20261102T181500')), { written: ['20261102T183012'], found: ['20261001T090000'] })
  assert.deepEqual(parseNoteLists(yaml), { written: [], found: [] })
})

test('setNoteLists replaces the block in place and keeps other keys and CRLF', () => {
  const yaml = 'title: A\r\nnotes:\r\n  written: [20261102T181500]\r\n  found: []\r\nprofile: x\r\n'
  const out = setNoteLists(yaml, { written: ['20261102T181500'], found: ['20261001T090000', '20261102T181500'] })
  assert.equal(out, 'title: A\r\nnotes:\r\n  written: [20261102T181500]\r\n  found: [20261001T090000]\r\nprofile: x\r\n')
})

test('inRootNotes is the notes folder and what is in it, ignoring case', () => {
  assert.equal(inRootNotes('/r/notes/x.md', '/r'), true)
  assert.equal(inRootNotes('/R/Notes', '/r/'), true)
  assert.equal(inRootNotes('/r/notes-old/x.md', '/r'), false)
  assert.equal(inRootNotes('/r/analyses/a/notes/x.md', '/r'), false)
})

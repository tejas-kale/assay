import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StaleEdit } from './errors.ts'
import {
  addFound,
  addWritten,
  freeId,
  idTime,
  inRootNotes,
  isNoteId,
  noteCitations,
  noteLines,
  noteTargets,
  noteTitle,
  replaceOnce,
  slugify,
  targetIndices,
  writeRootNote,
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
import type { NoteWriterIo } from './rootNotes.ts'

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
  assert.deepEqual(parseRootNote('20261102T181500-x.md', '# X\n\n[[20261006T090118|vw_panel]]\n', { mtimeMs: 0, size: 0 }).links, ['20261006T090118'])
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

test('slugify lowercases, joins runs of other characters with one dash, trims dashes and keeps 60 characters', () => {
  assert.equal(slugify('Churn by Region!'), 'churn-by-region')
  assert.equal(slugify('--a__b--'), 'a-b')
  assert.equal(slugify('---'), 'note')
  assert.equal(slugify(''), 'note')
  assert.equal(slugify('Été 2026'), 't-2026')
  assert.equal(slugify('x'.repeat(59) + ' y'), 'x'.repeat(59))
  assert.equal(slugify('x'.repeat(70)), 'x'.repeat(60))
  assert.equal(slugify('a'.repeat(58) + '--b'), 'a'.repeat(58) + '-b')
  assert.equal(slugify('a'.repeat(59) + '-bcd'), 'a'.repeat(59))
})

test('inRootNotes ignores any number of trailing slashes on the path and the root', () => {
  assert.equal(inRootNotes('/r/notes///', '/r///'), true)
  assert.equal(inRootNotes('/r/notes/sub/', '/r/'), true)
  assert.equal(inRootNotes('/r/notes/', '/r/notes'), false)
  assert.equal(inRootNotes('/r', '/r'), false)
  assert.equal(inRootNotes('/', '/'), false)
})

test('an ID is eight digits, a T, six digits and nothing else', () => {
  assert.equal(isNoteId('20261102T181500'), true)
  for (const bad of ['20261102T18150', '20261102T1815000', ' 20261102T181500', '20261102T181500\n', '']) assert.equal(isNoteId(bad), false, bad)
})

test('noteTitle is the first line when it is a one-hash heading with text', () => {
  assert.equal(noteTitle('# Churn  \n\nbody'), 'Churn')
  for (const text of ['', '#', '# ', '#  ', '#x', '## Two', 'body\n# Late', '\n# Late']) assert.equal(noteTitle(text), undefined, text)
  assert.equal(noteBody('no title\nline'), 'no title\nline')
  assert.equal(noteBody('# T'), '# T', 'a title with no newline after it is left whole')
})

test('noteBlocks reads headings by their hashes and spaces, fences by their info word, and paragraphs by blank lines', () => {
  const text = [
    '# One',
    '#   Spaced   out  ',
    '###### Six',
    '####### Seven',
    '#NoSpace',
    '# ',
    '#',
    '# a\rb',
    'para one',
    'still one',
    '',
    '~~~Python extra words',
    'x = 1',
    '```',
    '~~~',
    '```',
    'unclosed',
  ].join('\n')
  assert.deepEqual(noteBlocks(text), [
    { type: 'heading', level: 1, segments: [{ type: 'text', text: 'One' }] },
    { type: 'heading', level: 1, segments: [{ type: 'text', text: 'Spaced   out  ' }] },
    { type: 'heading', level: 6, segments: [{ type: 'text', text: 'Six' }] },
    { type: 'paragraph', segments: [{ type: 'text', text: '####### Seven\n#NoSpace' }] },
    { type: 'heading', level: 1, segments: [] },
    { type: 'paragraph', segments: [{ type: 'text', text: '#\n# a\rb\npara one\nstill one' }] },
    { type: 'code', text: 'x = 1\n```', lang: 'python' },
    { type: 'code', text: 'unclosed' },
  ])
})

test('noteLines marks the fence lines and what is inside them, and keeps the line endings', () => {
  assert.deepEqual(noteLines('a\n```\nb\n```\nc'), [
    { line: 'a', eol: '\n', fenced: false },
    { line: '```', eol: '\n', fenced: true },
    { line: 'b', eol: '\n', fenced: true },
    { line: '```', eol: '\n', fenced: true },
    { line: 'c', eol: '', fenced: false },
  ])
})

test('replaceOnce refuses an old text that is missing, empty or repeated, and replaces a unique one', () => {
  assert.equal(replaceOnce('abc', 'b', 'XX'), 'aXXc')
  assert.throws(() => replaceOnce('aa', 'a', 'b'), /more than once/)
  assert.throws(() => replaceOnce('abc', 'z', 'b'), /not in the note/)
})

test('the targets are the links and citations outside code, in reading order, each with its index', () => {
  const blocks = noteBlocks('# H [[20261001T090000]]\n\n[a q 1] text [[20261002T090000|x]]\n\n```\n[[20261003T090000]]\n```\n')
  assert.deepEqual(noteTargets(blocks), [
    { type: 'link', id: '20261001T090000' },
    { type: 'citation', analysis: 'a', number: 1 },
    { type: 'link', id: '20261002T090000' },
  ])
  const indices = [...targetIndices(blocks).values()]
  assert.deepEqual(indices, [0, 1, 2])
  assert.deepEqual(noteCitations('x [a q 2] [[20261001T090000]] [b q 3]').map(c => c.number), [2, 3])
})

test('the notes lists read keys in any case, with quotes, comments and CRLF, and drop what is not an ID', () => {
  const yaml = [
    'title: x',
    'NOTES : # the lists',
    "  Written: ['20261102T181500', \"20261102T183012\", nope, ]  # mine",
    '  found:[20261001T090000]\r',
    '  other: [20261001T090001]',
    '  found: [20261001T090002]\r',
    'next: 1',
    '  found: [20261001T090003]',
  ].join('\n')
  assert.deepEqual(parseNoteLists(yaml), { written: ['20261102T181500', '20261102T183012'], found: ['20261001T090002'] })
  assert.deepEqual(parseNoteLists('notes:\n'), { written: [], found: [] })
  assert.deepEqual(parseNoteLists('notesx:\n  written: [20261102T181500]'), { written: [], found: [] })
})

test('setNoteLists appends a block when there is none, with the file\'s line endings, and dedupes', () => {
  const lists = { written: ['20261102T181500', '20261102T181500'], found: ['20261102T181500', '20261001T090000', '20261001T090000'] }
  const block = 'notes:\n  written: [20261102T181500]\n  found: [20261001T090000]\n'
  assert.equal(setNoteLists('', lists), block)
  assert.equal(setNoteLists('a: 1\n', lists), 'a: 1\n' + block)
  assert.equal(setNoteLists('a: 1', lists), 'a: 1\n' + block)
  assert.equal(setNoteLists('a: 1\r\n', lists), 'a: 1\r\n' + block.replaceAll('\n', '\r\n'))
  assert.equal(setNoteLists('a: 1', { written: [], found: [] }), 'a: 1\nnotes:\n  written: []\n  found: []\n')
})

function fakeNoteIo(overrides: Partial<NoteWriterIo> = {}) {
  const created: { path: string; text: string }[] = []
  const calls: string[] = []
  let yaml = 'title: x\n'
  const io: NoteWriterIo = {
    readdir: () => Promise.resolve(['20261102T181500-old.md']),
    mkdir: path => {
      calls.push(`mkdir ${path}`)
      return Promise.resolve()
    },
    createFile: (path, text) => {
      created.push({ path, text })
      return Promise.resolve()
    },
    editYaml: change => {
      yaml = change(yaml)
      return Promise.resolve()
    },
    ...overrides,
  }
  return { io, created, calls, yaml: () => yaml }
}

const NOW = new Date(2026, 10, 2, 18, 15, 0)

/** A rejection reason that is not an Error (a port may reject with anything), though it reads like one to the type checker. */
const plainReason = (text: string) => Object.setPrototypeOf(new Error(text), { toString: () => text }) as Error

test('writeRootNote writes the note under a free ID, qualifies bare citations and lists the ID', async () => {
  const fake = fakeNoteIo()
  const result = await writeRootNote(fake.io, { dir: '/r/notes', slug: 'churn', title: ' A  note ', body: 'Rate [q 3]', now: NOW })
  assert.deepEqual(result, {
    ok: true,
    id: '20261102T181501',
    file: '20261102T181501-a-note.md',
    text: '# A note\n\nRate [churn q 3]\n',
    listed: true,
  })
  assert.deepEqual(fake.calls, ['mkdir /r/notes'])
  assert.deepEqual(fake.created, [{ path: '/r/notes/20261102T181501-a-note.md', text: '# A note\n\nRate [churn q 3]\n' }])
  assert.match(fake.yaml(), /written: \[20261102T181501\]/)
})

test('writeRootNote refuses an empty title or a text over maxLength before touching the disk', async () => {
  const fake = fakeNoteIo()
  assert.deepEqual(await writeRootNote(fake.io, { dir: '/d', slug: 's', title: '  ', body: 'b' }), { ok: false, reason: 'title' })
  assert.deepEqual(await writeRootNote(fake.io, { dir: '/d', slug: 's', title: 't', body: 'x'.repeat(20), maxLength: 10 }), { ok: false, reason: 'size' })
  assert.deepEqual(fake.calls, [])
  const fits = await writeRootNote(fake.io, { dir: '/d', slug: 's', title: 't', body: '', maxLength: 4, now: NOW })
  assert.equal(fits.ok, true)
})

test('writeRootNote treats a missing notes folder as empty and looks again when another writer took the ID', async () => {
  let attempts = 0
  const fake = fakeNoteIo({
    readdir: () => Promise.reject(new Error('ENOENT')),
    createFile: () => {
      attempts++
      return attempts < 3 ? Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' })) : Promise.resolve()
    },
  })
  const result = await writeRootNote(fake.io, { dir: '/d', slug: 's', title: 't', body: 'b', now: NOW })
  assert.equal(result.ok && result.id, '20261102T181500')
  assert.equal(attempts, 3)
})

test('writeRootNote gives up after 20 taken IDs and rethrows any other write error', async () => {
  const taken = fakeNoteIo({ createFile: () => Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' })) })
  assert.deepEqual(await writeRootNote(taken.io, { dir: '/d', slug: 's', title: 't', body: 'b', now: NOW }), { ok: false, reason: 'id' })
  for (const failure of [new Error('disk full'), plainReason('plain')]) {
    const broken = fakeNoteIo({ createFile: () => Promise.reject(failure) })
    await assert.rejects(writeRootNote(broken.io, { dir: '/d', slug: 's', title: 't', body: 'b', now: NOW }), (error: unknown) => error === failure)
  }
})

test('writeRootNote still writes the note when analysis.yaml cannot take the ID, and says why', async () => {
  const withError = fakeNoteIo({ editYaml: () => Promise.reject(new Error('read-only')) })
  const first = await writeRootNote(withError.io, { dir: '/d', slug: 's', title: 't', body: 'b', now: NOW })
  assert.equal(first.ok && first.listed, 'read-only')
  const withText = fakeNoteIo({ editYaml: () => Promise.reject(plainReason('locked')) })
  const second = await writeRootNote(withText.io, { dir: '/d', slug: 's', title: 't', body: 'b', now: NOW })
  assert.equal(second.ok && second.listed, 'locked')
  assert.equal(withText.created.length, 1)
})

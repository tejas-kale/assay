import assert from 'node:assert/strict'
import { test } from 'node:test'

import { backlinks, nextNoteNumber, noteBlocks, noteBody, noteFileName, noteSegments, noteTargets, targetIndices, parseNoteFile, parseNoteFileName, resolveLink, slugify } from './noteFiles.ts'

test('parseNoteFileName accepts NNN-slug.md and nothing else', () => {
  assert.deepEqual(parseNoteFileName('004-churn-by-region.md'), { number: 4, slug: 'churn-by-region' })
  assert.deepEqual(parseNoteFileName('1000-a.md'), { number: 1000, slug: 'a' })
  assert.deepEqual(parseNoteFileName('001-2024-plan.md'), { number: 1, slug: '2024-plan' })
  for (const bad of ['01-a.md', '004-.md', '004--a.md', '004-A.md', '004-a b.md', '004-a.txt', 'a-004.md', '.004-a.md', '004-a.md.tmp', '004-a_b.md']) {
    assert.equal(parseNoteFileName(bad), undefined, bad)
  }
})

test('nextNoteNumber is the highest number plus one, ignoring other names', () => {
  assert.equal(nextNoteNumber([]), 1)
  assert.equal(nextNoteNumber(['001-a.md', '007-b.md', '003-c.md', 'readme.md']), 8)
})

test('noteFileName pads to three digits', () => {
  assert.equal(noteFileName(4, 'x'), '004-x.md')
  assert.equal(noteFileName(1234, 'x'), '1234-x.md')
})

test('slugify lower-cases, collapses other characters, trims and caps at 60', () => {
  assert.equal(slugify('Churn by Region!'), 'churn-by-region')
  assert.equal(slugify('  --Hello,   World--  '), 'hello-world')
  assert.equal(slugify('???'), 'note')
  assert.equal(slugify(''), 'note')
  assert.equal(slugify('a'.repeat(80)).length, 60)
  assert.equal(slugify('a'.repeat(59) + ' bbb'), 'a'.repeat(59))
})

const NO_STAT = { mtimeMs: 0, size: 0 }

test('parseNoteFile reads the title, links and citations in order of first appearance', () => {
  const text = '# Churn\n\nSee [[retention]] and [[002-x]], again [[retention]]. Cited [q 12], [q 012] and [q 3].\n'
  assert.deepEqual(parseNoteFile('004-churn.md', text, { mtimeMs: 5, size: 9 }), {
    name: '004-churn.md',
    number: 4,
    slug: 'churn',
    title: 'Churn',
    links: ['retention', '002-x'],
    citations: [12, 3],
    mtimeMs: 5,
    size: 9,
  })
})

test('a file without a title line takes its slug as the title', () => {
  assert.equal(parseNoteFile('004-churn.md', 'Just text [[a]]\n', NO_STAT).title, 'churn')
  assert.equal(parseNoteFile('004-churn.md', '#Not a title\n', NO_STAT).title, 'churn')
  assert.equal(parseNoteFile('004-churn.md', '#   \n', NO_STAT).title, 'churn')
})

test('links and citations inside fenced code blocks are ignored', () => {
  const text = '# T\n\n```\n[[hidden]] [q 9]\n```\n[[shown]] [q 1]\n~~~py\n[[also-hidden]]\n~~~\n'
  const note = parseNoteFile('001-t.md', text, NO_STAT)
  assert.deepEqual(note.links, ['shown'])
  assert.deepEqual(note.citations, [1])
})

test('noteBody drops the title line and the blank line after it', () => {
  assert.equal(noteBody('# T\n\nBody\n'), 'Body\n')
  assert.equal(noteBody('Body only\n'), 'Body only\n')
})

test('noteSegments splits text into plain, link and citation segments', () => {
  assert.deepEqual(noteSegments('a [[x]] b [q 012] c'), [
    { type: 'text', text: 'a ' },
    { type: 'link', target: 'x' },
    { type: 'text', text: ' b ' },
    { type: 'citation', number: 12 },
    { type: 'text', text: ' c' },
  ])
  assert.deepEqual(noteSegments(''), [])
})

test('noteBlocks gives headings, paragraphs and code; fenced text stays plain', () => {
  const blocks = noteBlocks('## Why\n\nFirst [[a]]\nsecond line\n\n```py\nx = [[1]]  # [q 5]\n```\n\nEnd')
  assert.deepEqual(blocks, [
    { type: 'heading', level: 2, segments: [{ type: 'text', text: 'Why' }] },
    { type: 'paragraph', segments: [{ type: 'text', text: 'First ' }, { type: 'link', target: 'a' }, { type: 'text', text: '\nsecond line' }] },
    { type: 'code', text: 'x = [[1]]  # [q 5]' },
    { type: 'paragraph', segments: [{ type: 'text', text: 'End' }] },
  ])
})

const note = (name: string, text: string) => parseNoteFile(name, text, NO_STAT)

test('resolveLink matches a slug or the whole stem', () => {
  const notes = [note('001-a.md', '# A'), note('002-b.md', '# B')]
  assert.equal(resolveLink('b', notes)?.name, '002-b.md')
  assert.equal(resolveLink('001-a', notes)?.name, '001-a.md')
  assert.equal(resolveLink('c', notes), undefined)
})

test('backlinks lists the notes linking to a note, in number order, not itself', () => {
  const a = note('001-a.md', '# A\n[[a]] [[b]]')
  const b = note('002-b.md', '# B\n[[a]]')
  const c = note('003-c.md', '# C\n[[001-a]] [[b]]')
  assert.deepEqual(backlinks(a, [c, a, b]).map(n => n.name), ['002-b.md', '003-c.md'])
  assert.deepEqual(backlinks(c, [a, b, c]), [])
})

test('a link may contain a [ (as in the mod)', () => {
  const note = parseNoteFile('001-t.md', '# T\n\nSee [[a[b]] and [[c]].\n', NO_STAT)
  assert.deepEqual(note.links, ['a[b', 'c'])
})

test('noteTargets lists links and citations in reading order, skipping code, then backlinks', () => {
  const blocks = noteBlocks('Intro [[a]] [q 2]\n\n```\n[[hidden]]\n```\n\n## H [q 1]\n')
  const from = parseNoteFile('002-b.md', '# B', NO_STAT)
  assert.deepEqual(noteTargets(blocks, [from]), [
    { type: 'link', target: 'a' },
    { type: 'citation', number: 2 },
    { type: 'citation', number: 1 },
    { type: 'backlink', name: '002-b.md' },
  ])
})

test('targetIndices numbers the segments as noteTargets lists them', () => {
  const blocks = noteBlocks('Intro [[a]] [q 2]\n\n```\n[[hidden]]\n```\n\n## H [q 1]\n')
  const indices = targetIndices(blocks)
  const segments = blocks.flatMap(b => (b.type === 'code' ? [] : b.segments)).filter(s => s.type !== 'text')
  assert.deepEqual(segments.map(s => indices.get(s)), [0, 1, 2])
  assert.equal(indices.size, 3)
})

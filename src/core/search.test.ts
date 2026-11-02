import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listFacts } from './facts.ts'
import type { NoteFile } from './noteFiles.ts'
import { parseRuns } from './runs.ts'
import { factPreview, sameTarget, search, searchEntries, snippetOf } from './search.ts'
import type { SearchSources } from './search.ts'

const note = (name: string, number: number, title: string): NoteFile => ({
  name, number, slug: name.slice(4, -3), title, links: [], citations: [], mtimeMs: 0, size: 0,
})

const runs = parseRuns(['011_daily_users.sql', '011_daily_users.csv', '012_churn.py', '012_churn.json', '012_churn.p1.png'])

const sources: SearchSources = {
  facts: listFacts('Churn is 4% [queried q 11]\nPlain fact\n[Method](<notes/001-method.md>)\n'),
  threads: { open: ['Why did churn rise'], closed: [{ thread: 'Check dupes', outcome: 'none found' }] },
  noteFiles: [note('001-method.md', 1, 'Method')],
  runs,
  files: [
    { path: 'notes.md', size: 1, mtimeMs: 3, kind: 'text' },
    { path: 'notes/001-method.md', size: 1, mtimeMs: 2, kind: 'text' },
    { path: 'queries/012_churn.p1.png', size: 1, mtimeMs: 2, kind: 'image' },
    { path: 'queries/README.md', size: 1, mtimeMs: 1, kind: 'text' },
    { path: 'lib/helpers.py', size: 1, mtimeMs: 1, kind: 'text' },
  ],
  contents: {
    notes: [{ name: '001-method.md', text: '# Method\n\nWe drop test accounts before counting.\n' }],
    runs: [{ number: 12, code: 'df = q(11)\nrate = df.churned.mean()\n' }],
  },
}

test('searchEntries lists open threads, facts, notes, runs newest first, files, then closed threads', () => {
  const titles = searchEntries(sources).map(e => `${e.target.kind}:${e.title}`)
  assert.deepEqual(titles, [
    'thread:Why did churn rise',
    'fact:Churn is 4%',
    'fact:Plain fact',
    'fact:Method',
    'note:Method 001',
    'run:012 churn',
    'run:011 daily_users',
    'file:notes.md',
    'file:queries/README.md',
    'file:lib/helpers.py',
    'thread:Check dupes → none found',
  ])
})

test('files a note or run already stands for are left out, other files in those folders stay', () => {
  const files = searchEntries(sources).filter(e => e.target.kind === 'file').map(e => e.title)
  assert.ok(!files.includes('notes/001-method.md'))
  assert.ok(!files.includes('queries/012_churn.p1.png'))
  assert.ok(files.includes('queries/README.md'))
})

test('previews: a fact shows its note file, else its run code, else its text', () => {
  const [cited, plain, linked] = sources.facts
  assert.deepEqual(factPreview(cited!, runs), { type: 'path', path: 'queries/011_daily_users.sql' })
  assert.deepEqual(factPreview(plain!, runs), { type: 'text', text: 'Plain fact' })
  assert.deepEqual(factPreview(linked!, runs), { type: 'path', path: 'notes/001-method.md' })
  const note = searchEntries(sources).find(e => e.target.kind === 'note')
  assert.deepEqual(note?.preview, { type: 'path', path: 'notes/001-method.md' })
})

test('search puts name hits first, then body hits with the matching line', () => {
  const hits = search(searchEntries(sources), 'churn')
  const kinds = hits.map(h => h.entry.target)
  assert.deepEqual(kinds.slice(0, 3).map(t => t.kind).sort(), ['fact', 'run', 'thread'])
  const body = search(searchEntries(sources), 'test accounts')
  assert.equal(body.length, 1)
  assert.deepEqual(body[0]?.entry.target, { kind: 'note', name: '001-method.md' })
  assert.equal(body[0]?.snippet, 'We drop test accounts before counting.')
})

test('a body hit is not repeated when the name already matched', () => {
  const hits = search(searchEntries(sources), 'churn')
  const runHits = hits.filter(h => h.entry.target.kind === 'run' && h.entry.title.includes('churn'))
  assert.equal(runHits.length, 1)
  assert.equal(runHits[0]?.snippet, undefined)
})

test('an empty query gives every entry up to the limit; a one-letter query does not search bodies', () => {
  assert.equal(search(searchEntries(sources), '  ').length, 11)
  assert.equal(search(searchEntries(sources), '', 3).length, 3)
  assert.ok(search(searchEntries(sources), 'q').every(h => h.snippet === undefined))
})

test('snippetOf cuts a long line around the match', () => {
  const long = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`
  const cut = snippetOf(long, 'NEEDLE') ?? ''
  assert.ok(cut.includes('needle'))
  assert.ok(cut.startsWith('…') && cut.endsWith('…'))
  assert.ok(cut.length <= 92)
  assert.equal(snippetOf('x\ny', 'zz'), undefined)
})

test('sameTarget compares by value', () => {
  assert.ok(sameTarget({ kind: 'run', number: 1 }, { kind: 'run', number: 1 }))
  assert.ok(!sameTarget({ kind: 'thread', closed: false, index: 0 }, { kind: 'thread', closed: true, index: 0 }))
})

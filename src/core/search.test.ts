import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RootNote } from './rootNotes.ts'
import { parseRuns } from './runs.ts'
import { sameTarget, search, searchEntries, snippetOf } from './search.ts'
import type { SearchSources } from './search.ts'

const note = (id: string, title: string): RootNote => ({
  name: `${id}-x.md`, id, slug: 'x', title, links: [], citations: [], mtimeMs: 0, size: 0,
})

const runs = parseRuns(['011_daily_users.sql', '011_daily_users.csv', '012_churn.py', '012_churn.json', '012_churn.p1.png'])

const sources: SearchSources = {
  threads: { open: ['Why did churn rise'], closed: [{ thread: 'Check dupes', outcome: 'none found' }] },
  notes: [note('20261001T090000', 'Method'), note('20261102T181500', 'Churn is 4%')],
  runs,
  files: [
    { path: 'analysis.yaml', size: 1, mtimeMs: 3, kind: 'text' },
    { path: 'queries/012_churn.p1.png', size: 1, mtimeMs: 2, kind: 'image' },
    { path: 'queries/README.md', size: 1, mtimeMs: 1, kind: 'text' },
    { path: 'lib/helpers.py', size: 1, mtimeMs: 1, kind: 'text' },
  ],
  contents: {
    notes: [{ name: '20261001T090000-x.md', text: '# Method\n\nWe drop test accounts before counting.\n' }],
    runs: [{ number: 12, code: 'df = q(11)\nrate = df.churned.mean()\n' }],
  },
}

test('searchEntries lists open threads, every root note newest first, runs newest first, files, then closed threads', () => {
  const titles = searchEntries(sources).map(e => `${e.target.kind}:${e.title}`)
  assert.deepEqual(titles, [
    'thread:Why did churn rise',
    'note:Churn is 4%',
    'note:Method',
    'run:012 churn',
    'run:011 daily_users',
    'file:analysis.yaml',
    'file:queries/README.md',
    'file:lib/helpers.py',
    'thread:Check dupes → none found',
  ])
})

test('files a run already stands for are left out, other files in that folder stay', () => {
  const files = searchEntries(sources).filter(e => e.target.kind === 'file').map(e => e.title)
  assert.ok(!files.includes('queries/012_churn.p1.png'))
  assert.ok(files.includes('queries/README.md'))
})

test('a note previews its text once read, else its title', () => {
  const [churn, method] = searchEntries(sources).filter(e => e.target.kind === 'note')
  assert.deepEqual(churn?.preview, { type: 'text', text: 'Churn is 4%' })
  assert.deepEqual(method?.preview, { type: 'text', text: '# Method\n\nWe drop test accounts before counting.\n' })
})

test('search puts name hits first, then body hits with the matching line', () => {
  const hits = search(searchEntries(sources), 'churn')
  const kinds = hits.map(h => h.entry.target)
  assert.deepEqual(kinds.slice(0, 3).map(t => t.kind).sort(), ['note', 'run', 'thread'])
  const body = search(searchEntries(sources), 'test accounts')
  assert.equal(body.length, 1)
  assert.deepEqual(body[0]?.entry.target, { kind: 'note', name: '20261001T090000-x.md' })
  assert.equal(body[0]?.snippet, 'We drop test accounts before counting.')
})

test('a body hit is not repeated when the name already matched', () => {
  const hits = search(searchEntries(sources), 'churn')
  const runHits = hits.filter(h => h.entry.target.kind === 'run' && h.entry.title.includes('churn'))
  assert.equal(runHits.length, 1)
  assert.equal(runHits[0]?.snippet, undefined)
})

test('an empty query gives every entry up to the limit; a one-letter query does not search bodies', () => {
  assert.equal(search(searchEntries(sources), '  ').length, 9)
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

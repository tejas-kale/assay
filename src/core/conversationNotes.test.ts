import { test } from 'node:test'
import { expect } from '../testing/expect.ts'
import { conversationNoteRow, parseNoteDiff } from './conversationNotes.ts'

test('a successful note shows its Markdown with the server acknowledgement and warnings', () => {
  expect(conversationNoteRow({ tool: 'mcp__assay__note', input: { title: 'A finding', text: '**Seven** sites.' }, output: 'Wrote notes/20261112T120000-finding.md.\nUnknown runs: alpha q 99.' })).toEqual({
    kind: 'note', markdown: '# A finding\n\n**Seven** sites.\n', text: 'Wrote notes/20261112T120000-finding.md.\nUnknown runs: alpha q 99.',
  })
})

test('a successful revision shows the exact replaced lines as a parsed diff hunk', () => {
  expect(conversationNoteRow({ tool: 'mcp__assay__revise_note', input: { id: '20261112T120000', old: 'Seven sites.\nAll active.', new: 'Eight sites.' }, output: 'Revised notes/20261112T120000-finding.md.' })).toEqual({
    kind: 'noteDiff', text: 'Revised notes/20261112T120000-finding.md.',
    diff: '@@ -1,2 +1,1 @@\n-Seven sites.\n-All active.\n+Eight sites.',
    hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 1, lines: ['-Seven sites.', '-All active.', '+Eight sites.'] }],
  })
})

test('title revisions and deletions show the acknowledgement without inventing previous text', () => {
  expect(conversationNoteRow({ tool: 'mcp__assay__revise_note', input: { title: 'New title' }, output: 'Revised notes/20261112T120000-finding.md.' })).toEqual({ kind: 'noteDiff', text: 'Revised notes/20261112T120000-finding.md.', diff: 'Revised notes/20261112T120000-finding.md.', hunks: [] })
  expect(conversationNoteRow({ tool: 'mcp__assay__revise_note', input: { delete: true }, output: 'Deleted notes/20261112T120000-finding.md.' })).toMatchObject({ kind: 'noteDiff', hunks: [] })
})

test('each thread operation names the affected thread in one line', () => {
  const cases = [
    ['park', { thread: 'Why seven?' }, 'Parked. 2 open threads.', 'Parked: Why seven? · Parked. 2 open threads.'],
    ['close', { thread: '2' }, 'Closed "Why seven?". No open threads left.', 'Closed "Why seven?". No open threads left.'],
    ['focus', { thread: '3' }, 'Focused: 1. Why seven?', 'Focused: 1. Why seven?'],
    ['order', { threads: ['2', '1'] }, 'Open threads now:\n1. Why seven?\n2. Which sites?', 'Open threads now: 1. Why seven? · 2. Which sites?'],
  ] as const
  for (const [tool, input, output, text] of cases) {
    expect(conversationNoteRow({ tool: `mcp__assay__${tool}`, input, output })).toEqual({ kind: 'thread', text })
  }
})

test('note linking and citation labels collapse output to one line without hiding warnings', () => {
  expect(conversationNoteRow({ tool: 'mcp__assay__link_notes', input: { ids: ['20261112T120000'] }, output: 'Linked 20261112T120000 Finding.' })).toEqual({ kind: 'thread', text: 'Linked 20261112T120000 Finding.' })
  expect(conversationNoteRow({ tool: 'mcp__assay__note_labels', input: {}, output: '20261112T120000 Finding\n[alpha q 1] missing\n\nStale was not checked.' })).toEqual({ kind: 'thread', text: '20261112T120000 Finding · [alpha q 1] missing · Stale was not checked.' })
})

test('running, failed, unknown and invalid calls retain the engine row', () => {
  const call = { tool: 'mcp__assay__note', input: { title: 'Finding', text: 'Seven.' }, output: 'Wrote notes/file.md.' }
  for (const change of [{ isRunning: true }, { isErrored: true }, { input: null }, { input: 'invalid' }, { input: {} }, { output: 'Give the note a title.' }, { output: undefined }, { tool: 'Read' }]) {
    expect(conversationNoteRow({ ...call, ...change })).toEqual({ kind: 'engine' })
  }
})

test('an empty thread result falls back to the engine rather than hiding the call', () => {
  expect(conversationNoteRow({ tool: 'mcp__assay__focus', input: { thread: '1' } })).toEqual({ kind: 'engine' })
})


test('diff parsing preserves multiple hunks and rejects malformed counts or text', () => {
  expect(parseNoteDiff('@@ -3,1 +3,1 @@\n-old\n+new\n@@ -8,0 +9,1 @@\n+extra')).toEqual([
    { oldStart: 3, oldCount: 1, newStart: 3, newCount: 1, lines: ['-old', '+new'] },
    { oldStart: 8, oldCount: 0, newStart: 9, newCount: 1, lines: ['+extra'] },
  ])
  for (const diff of ['plain text', '@@ -1,2 +1,1 @@\n-old\n+new', '@@ -1,1 +1,1 @@\nbroken', '@@ -1,0 +1,0 @@', '']) {
    expect(parseNoteDiff(diff)).toBeUndefined()
  }
})

test('note revisions retain unchanged prefix and suffix lines as context', () => {
  const row = conversationNoteRow({ tool: 'mcp__assay__revise_note', input: { old: 'Same title\nSeven sites.\nAll active.', new: 'Same title\nEight sites.\nAll active.' }, output: 'Revised notes/finding.md.' })
  expect(row).toMatchObject({ kind: 'noteDiff', diff: '@@ -1,3 +1,3 @@\n Same title\n-Seven sites.\n+Eight sites.\n All active.' })
})

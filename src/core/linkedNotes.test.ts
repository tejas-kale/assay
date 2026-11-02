// The analysis mod's tests of a linked note file's title (config b2f7df2, claude/analysis/tests/model.test.ts).
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { fileNoteLine, parseFileNote } from './facts.ts'
import { baseName, paragraphs as noteBlocks, titleOf } from './linkedNotes.ts'

test('a note file is linked from notes.md by its title and path', async () => {
  const line = fileNoteLine('Why [alpha] is 0', '/repos/llm-wiki/data (old)/alpha.md')
  expect(line).toBe('[Why alpha is 0](</repos/llm-wiki/data (old)/alpha.md>)')
  expect(parseFileNote(line)).toEqual({ title: 'Why alpha is 0', path: '/repos/llm-wiki/data (old)/alpha.md' })
  expect(parseFileNote('see [docs](https://example.com)')).toBeUndefined()
  expect(baseName('/repos/wiki/alpha-rules.md')).toBe('alpha-rules')
})

const ORG = `:PROPERTIES:
:ID: 1234
:END:
#+title: Engage discounted counters: matured, completes and returns
#+filetags: :engage:

* Matured
A counter matures after thirty days
and then stops.

#+begin_src sql

SELECT 1
#+end_src
`

test('a note title is org #+title, front matter title, else the first line', async () => {
  expect(titleOf(ORG)).toBe('Engage discounted counters: matured, completes and returns')
  expect(titleOf('\n## Alpha rules ##\nbody')).toBe('Alpha rules')
  expect(titleOf('Plain first line\nbody')).toBe('Plain first line')
  expect(titleOf('---\ntags: [a]\ntitle: "Alpha: rules"\n---\n# Other\n')).toBe('Alpha: rules')
  expect(titleOf('---\ntags: [a]\n---\n\n# Heading\n')).toBe('Heading')
  expect(titleOf(':PROPERTIES:\n:ID: 1\n:END:\n\n** Org heading\n')).toBe('Org heading')
  expect(titleOf('  \n')).toBeUndefined()
})

test('a note splits into paragraphs; keywords, drawers and front matter are meta; code stays whole', async () => {
  const lines = ORG.split('\n')
  const blocks = noteBlocks(lines)
  expect(blocks.map(block => [lines[block.start], block.isMeta])).toEqual([
    [':PROPERTIES:', true],
    ['* Matured', false],
    ['#+begin_src sql', false],
  ])
  expect(lines.slice(blocks[2]!.start, blocks[2]!.end)).toEqual(['#+begin_src sql', '', 'SELECT 1', '#+end_src'])
  const md = '---\ntitle: x\n\nmore: y\n---\n\nBody one\n\nBody two'.split('\n')
  expect(noteBlocks(md)).toEqual([
    { start: 0, end: 5, isMeta: true },
    { start: 6, end: 7, isMeta: false },
    { start: 8, end: 9, isMeta: false },
  ])
})

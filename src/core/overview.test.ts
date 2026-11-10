import assert from 'node:assert/strict'
import { test } from 'node:test'

import { baselinePath, hasChanges, lineCount, markdownBlocks, overviewDiff, systemOf } from './overview.ts'

test('the system is named on a line of its own among the first 5 lines, with an optional ^ or > before it', () => {
  assert.equal(systemOf('# Buyer rating\nSystem: systems/buyer-rating.md\n'), 'systems/buyer-rating.md')
  assert.equal(systemOf('# Buyer rating\n^ System: systems/Buyer-Rating.md\n'), 'systems/buyer-rating.md')
  assert.equal(systemOf('# T\n> System: systems/engage.md'), 'systems/engage.md')
  assert.equal(systemOf('1\n2\n3\n4\n5\nSystem: systems/late.md'), undefined)
  assert.equal(systemOf('# T\nSystem: systems/bad name.md'), undefined)
  assert.equal(systemOf('# T\nSystem: other/x.md'), undefined)
  assert.equal(systemOf('# T\nThe System: systems/x.md is ours'), undefined)
})

test('lines are counted without the final newline', () => {
  assert.equal(lineCount(''), 0)
  assert.equal(lineCount('a\nb\n'), 2)
  assert.equal(lineCount('a\nb'), 2)
})

test('blocks: headings, paragraphs, each list item with its continuation, whole tables and fenced code', () => {
  const text = [
    '# Title',
    'System: systems/x.md',
    '',
    'A paragraph',
    'over two lines.',
    '',
    '- one',
    '  more of one',
    '- two',
    '1. three',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```mermaid',
    'flowchart LR',
    '',
    'a --> b',
    '```',
    'After.',
  ].join('\n')
  assert.deepEqual(markdownBlocks(text), [
    '# Title',
    'System: systems/x.md',
    'A paragraph\nover two lines.',
    '- one\n  more of one',
    '- two',
    '1. three',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '```mermaid\nflowchart LR\n\na --> b\n```',
    'After.',
  ])
})

test('without a baseline every block is new', () => {
  assert.deepEqual(overviewDiff(undefined, '# A\n\nB\n'), [
    { kind: 'added', text: '# A' },
    { kind: 'added', text: 'B' },
  ])
})

test('an unchanged document has no changes', () => {
  const diff = overviewDiff('# A\n\nB\n', '# A\n\nB\n')
  assert.equal(hasChanges(diff), false)
  assert.deepEqual(diff.map(b => b.kind), ['same', 'same'])
})

test('a rewritten paragraph shows as the old block removed, then the new one added', () => {
  const before = '# Answer\n\nThe rate is 0.77.\n\n## Method\n\nBeta-binomial.\n'
  const after = '# Answer\n\nThe rate is 0.49 once Dropped is excluded.\n\n## Method\n\nBeta-binomial.\n'
  assert.deepEqual(overviewDiff(before, after), [
    { kind: 'same', text: '# Answer' },
    { kind: 'removed', text: 'The rate is 0.77.' },
    { kind: 'added', text: 'The rate is 0.49 once Dropped is excluded.' },
    { kind: 'same', text: '## Method' },
    { kind: 'same', text: 'Beta-binomial.' },
  ])
})

test('a removed section and an added list item', () => {
  const before = '# A\n\n## Old\n\nGone.\n\n- x\n'
  const after = '# A\n\n- x\n- y\n'
  assert.deepEqual(overviewDiff(before, after), [
    { kind: 'same', text: '# A' },
    { kind: 'removed', text: '## Old' },
    { kind: 'removed', text: 'Gone.' },
    { kind: 'same', text: '- x' },
    { kind: 'added', text: '- y' },
  ])
})

test('baselines live under .assay/overview-read, the system one by its path from the root', () => {
  assert.equal(baselinePath('analysis', undefined), '.assay/overview-read/overview.md')
  assert.equal(baselinePath('system', 'systems/x.md'), '.assay/overview-read/systems/x.md')
  assert.equal(baselinePath('system', undefined), undefined)
})

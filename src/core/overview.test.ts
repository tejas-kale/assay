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

test('blocks: where each kind of block ends and the next begins', () => {
  const text = [
    '| a |',
    'after a table',
    '- item',
    'not indented, so a new paragraph',
    '- item two',
    '  indented, so the same item',
    '# Heading right after text',
    'tail',
    '~~~',
    'tilde fence ``` stays open',
    '```',
    '~~~',
    '   - indented list item',
    '2) numbered',
    '4 spaces is code, not a list',
    '    - deep',
  ].join('\n')
  assert.deepEqual(markdownBlocks(text), [
    '| a |',
    'after a table',
    '- item',
    'not indented, so a new paragraph',
    '- item two\n  indented, so the same item',
    '# Heading right after text',
    'tail',
    '~~~\ntilde fence ``` stays open\n```\n~~~',
    '   - indented list item',
    '2) numbered',
    '4 spaces is code, not a list\n    - deep',
  ])
})

test('blocks: a fence that never closes runs to the end, and blank text has no blocks', () => {
  assert.deepEqual(markdownBlocks('before\n```\ncode\n\nmore'), ['before', '```\ncode\n\nmore'])
  assert.deepEqual(markdownBlocks('para\n```a\n```\n```b'), ['para', '```a\n```', '```b'])
  assert.deepEqual(markdownBlocks(''), [])
  assert.deepEqual(markdownBlocks('\n\n  \n'), [])
})

test('a diff of blocks that moved or repeat', () => {
  assert.deepEqual(overviewDiff('A\n\nB\n\nA\n', 'B\n\nA\n'), [
    { kind: 'removed', text: 'A' },
    { kind: 'same', text: 'B' },
    { kind: 'same', text: 'A' },
  ])
  assert.deepEqual(overviewDiff('A\n\nB\n', ''), [
    { kind: 'removed', text: 'A' },
    { kind: 'removed', text: 'B' },
  ])
  assert.deepEqual(overviewDiff('', 'A\n'), [{ kind: 'added', text: 'A' }])
  assert.deepEqual(overviewDiff('A\n\nB\n', 'B\n\nA\n').map(b => b.kind), ['removed', 'same', 'added'])
})

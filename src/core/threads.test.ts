import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StaleEdit } from './errors.ts'
import {
  addThread,
  closeOpen,
  deleteClosed,
  deleteOpen,
  editOpen,
  formatThreads,
  moveOpen,
  parseThreads,
} from './threads.ts'

// Ported from the mod's tests/model.test.ts.
const THREADS = `## Open
1. Why do some panels have alpha = 0?
2. Is \`completion_rate\` per respondent or per survey?

## Closed
- Does \`is_test\` exclude internal traffic? → yes, filter in all queries
- Is the table partitioned?
`

test('threads.md parses and formats back unchanged', () => {
  const threads = parseThreads(THREADS)
  assert.deepEqual(threads.open, [
    'Why do some panels have alpha = 0?',
    'Is `completion_rate` per respondent or per survey?',
  ])
  assert.deepEqual(threads.closed, [
    { thread: 'Does `is_test` exclude internal traffic?', outcome: 'yes, filter in all queries' },
    { thread: 'Is the table partitioned?' },
  ])
  assert.equal(formatThreads(threads), THREADS)
})

test('an empty threads.md is no threads', () => {
  assert.deepEqual(parseThreads(''), { open: [], closed: [] })
  assert.equal(formatThreads({ open: [], closed: [] }), '## Open\n\n## Closed\n')
})

test('addThread appends one line to the open list', () => {
  const text = addThread('', '  Why is beta\nnull?\n')
  assert.deepEqual(parseThreads(text).open, ['Why is beta null?'])
  assert.deepEqual(parseThreads(addThread(text, 'Second?')).open, ['Why is beta null?', 'Second?'])
})

test('addThread refuses empty input', () => {
  assert.throws(() => addThread(THREADS, '  \n '), /empty/i)
})

test('editOpen replaces one open thread when it still matches', () => {
  const next = editOpen(THREADS, 0, 'Why do some panels have alpha = 0?', 'Why is alpha 0 in some panels?')
  assert.deepEqual(parseThreads(next).open, [
    'Why is alpha 0 in some panels?',
    'Is `completion_rate` per respondent or per survey?',
  ])
  assert.deepEqual(parseThreads(next).closed, parseThreads(THREADS).closed)
})

test('editOpen throws StaleEdit when the thread changed or is gone', () => {
  assert.throws(() => editOpen(THREADS, 0, 'something else', 'x'), StaleEdit)
  assert.throws(() => editOpen(THREADS, 5, 'Why do some panels have alpha = 0?', 'x'), StaleEdit)
})

test('deleteOpen removes the thread', () => {
  const next = deleteOpen(THREADS, 1, 'Is `completion_rate` per respondent or per survey?')
  assert.deepEqual(parseThreads(next).open, ['Why do some panels have alpha = 0?'])
  assert.throws(() => deleteOpen(THREADS, 1, 'nope'), StaleEdit)
})

test('closeOpen moves the thread to the end of Closed, with an outcome when given', () => {
  const next = parseThreads(closeOpen(THREADS, 1, 'Is `completion_rate` per respondent or per survey?', ' per\nrespondent '))
  assert.deepEqual(next.open, ['Why do some panels have alpha = 0?'])
  assert.deepEqual(next.closed.at(-1), {
    thread: 'Is `completion_rate` per respondent or per survey?',
    outcome: 'per respondent',
  })
  const bare = parseThreads(closeOpen(THREADS, 0, 'Why do some panels have alpha = 0?', ''))
  assert.deepEqual(bare.closed.at(-1), { thread: 'Why do some panels have alpha = 0?' })
  assert.throws(() => closeOpen(THREADS, 0, 'nope', 'x'), StaleEdit)
})

test('deleteClosed removes a closed thread matching thread and outcome', () => {
  const next = deleteClosed(THREADS, 1, { thread: 'Is the table partitioned?' })
  assert.deepEqual(parseThreads(next).closed, [
    { thread: 'Does `is_test` exclude internal traffic?', outcome: 'yes, filter in all queries' },
  ])
  assert.throws(() => deleteClosed(THREADS, 0, { thread: 'Does `is_test` exclude internal traffic?' }), StaleEdit)
  assert.throws(() => deleteClosed(THREADS, 9, { thread: 'x' }), StaleEdit)
})

test('moveOpen shifts a thread by delta and clamps at the ends', () => {
  const abc = '## Open\n1. A?\n2. B?\n3. C?\n\n## Closed\n'
  assert.deepEqual(parseThreads(moveOpen(abc, 2, 'C?', -1)).open, ['A?', 'C?', 'B?'])
  assert.deepEqual(parseThreads(moveOpen(abc, 0, 'A?', 1)).open, ['B?', 'A?', 'C?'])
  assert.deepEqual(parseThreads(moveOpen(abc, 0, 'A?', -1)).open, ['A?', 'B?', 'C?'])
  assert.deepEqual(parseThreads(moveOpen(abc, 2, 'C?', 1)).open, ['A?', 'B?', 'C?'])
  assert.throws(() => moveOpen(abc, 1, 'A?', 1), StaleEdit)
})

test('open and closed lines parse by their marker, with any spacing', () => {
  const text = [
    '## Open',
    '1.no space',
    '  2.   spaced out  ',
    '3. ',
    '4.  \t ',
    ' 5. non-breaking indent',
    '7. line break inside',
    '## Closed',
    '-no space',
    '   -   padded → said   ',
    '- ',
    '-\t\ttabbed',
  ].join('\n')
  assert.deepEqual(parseThreads(text), {
    open: ['spaced out', 'non-breaking indent'],
    closed: [{ thread: 'padded', outcome: 'said' }, { thread: 'tabbed' }],
  })
})

test('lines that end in a carriage return are not threads', () => {
  assert.deepEqual(parseThreads('## Open\r\n1. a\r\n## Closed\r\n- b\r\n'), { open: [], closed: [] })
  assert.deepEqual(parseThreads('## Open\n1. \r x\n## Closed\n- \r y'), { open: ['x'], closed: [{ thread: 'y' }] })
})

import { test } from 'node:test'
import { expect } from '../testing/expect.ts'
import type { ConversationFiles } from './conversation.ts'
import { pythonConversation } from './conversationPython.ts'

const call = { tool: 'mcp__assay__python', input: { code: 'print(1)' }, output: { content: [{ type: 'text', text: 'Run 002: ok (0.2 s).' }] } }
const code = '# author: user\n# from: 001\nprint(1)\n'

test('Python rows show stdout, ordered table heads and plot names from a saved run', () => {
  const row = pythonConversation(call, {
    '002_trial.py': code,
    '002_trial.json': JSON.stringify({ status: 'ok', stdout: 'hello', tables: [
      { file: '002_trial.t2.csv', columns: ['b'], rowCount: 20 },
      { file: '002_trial.t1.csv', columns: ['a'], rowCount: 12 },
    ], plots: [{ file: '002_trial.p1.png' }] }),
    '002_trial.t1.csv': 'a\n' + Array.from({ length: 12 }, (_, i) => String(i)).join('\n') + '\n',
    '002_trial.t2.csv': 'b\n42\n',
    '002_trial.p1.png': '',
  })
  expect(row).toMatchObject({ kind: 'run', number: 2, author: 'user', language: 'python', code: 'print(1)\n', stdout: 'hello', plots: ['002_trial.p1.png'] })
  if (row.kind !== 'run') throw new Error('Expected run')
  expect(row.tables.map(table => [table.file, table.rows.length, table.rowCount])).toEqual([['002_trial.t1.csv', 10, 12], ['002_trial.t2.csv', 1, 20]])
})

test('Python rows retain output-only runs and show saved failures', () => {
  const files = { '002_trial.py': code, '002_trial.json': JSON.stringify({ status: 'ok', stdout: '42', tables: [], plots: [] }) }
  expect(pythonConversation(call, files)).toMatchObject({ kind: 'run', stdout: '42', tables: [], plots: [] })
  expect(pythonConversation(call, { ...files, '002_trial.json': JSON.stringify({ status: 'error', error: { name: 'ValueError', message: 'bad', traceback: 'ValueError: bad' } }) })).toMatchObject({ kind: 'run', error: 'ValueError: bad' })
})

test('Python rows fall back for unavailable or malformed saved results', () => {
  const cases: ConversationFiles[] = [ {}, { '002_trial.py': code }, { '002_trial.py': code, '002_trial.json': 'bad' },
    { '002_trial.py': code, '002_trial.json': JSON.stringify({ status: 'ok', tables: [{ file: '002_trial.t1.csv' }] }) },
  ]
  for (const files of cases) expect(pythonConversation(call, files)).toEqual({ kind: 'engine' })
  expect(pythonConversation({ ...call, output: 'No run' }, { '002_trial.py': code })).toEqual({ kind: 'engine' })
})

test('Python failure rows use the exception name when no traceback was saved', () => {
  expect(pythonConversation({ ...call, output: 'Run 002: failed' }, {
    '002_trial.py': 'print(1)', '002_trial.json': JSON.stringify({ status: 'error', error: { name: 'TypeError', message: 'wrong type', traceback: '' } }),
  })).toMatchObject({ kind: 'run', author: 'claude', error: 'TypeError: wrong type' })
})

test('Python rows refuse tables absent from the saved metadata', () => {
  const files = { '002_trial.py': code, '002_trial.json': JSON.stringify({ status: 'ok', tables: [], plots: [{ file: '../private.png' }] }), '002_trial.t1.csv': 'x\n1\n' }
  expect(pythonConversation(call, files)).toEqual({ kind: 'engine' })
})

test('Python calls show their code while still running', () => {
  expect(pythonConversation({ ...call, isRunning: true, input: { code: 'print(2)' } }, {})).toMatchObject({ kind: 'run', language: 'python', code: 'print(2)', running: true })
})

test('Python rows fall back when a plot named by the saved result is missing or outside the run', () => {
  for (const file of ['002_trial.p1.png', '../private.png']) {
    expect(pythonConversation(call, {
      '002_trial.py': code,
      '002_trial.json': JSON.stringify({ status: 'ok', tables: [], plots: [{ file }] }),
    })).toEqual({ kind: 'engine' })
  }
})

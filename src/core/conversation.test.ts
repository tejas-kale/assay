import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationRow } from './conversationBundle.ts'

test('SQL rows show recorded code, author and ten rows with full counts', () => {
  const row = conversationRow({ tool: 'mcp__assay__sql', input: {}, output: { content: [{ type: 'text', text: 'Run 42 saved' }] } }, {
    '042_example.sql': '-- author: user\nselect value from example',
    '042_example.csv': 'value\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n',
  })
  assert.equal(row.kind, 'run')
  assert.equal(row.number, 42)
  assert.equal(row.author, 'user')
  assert.equal(row.code, 'select value from example')
  assert.equal(row.tables[0]?.rowCount, 11)
  assert.equal(row.tables[0].columnCount, 1)
  assert.equal(row.tables[0].rows.length, 10)
})

test('real SQL output identifies its Query number', () => {
  const row = conversationRow({ tool: 'mcp__assay__sql', input: {}, output: { content: [{ type: 'text', text: 'Query 001: 1 rows, 1 columns' }] } }, {
    '001_one.sql': 'select 1', '001_one.csv': 'n\n1\n',
  })
  assert.equal(row.kind, 'run')
})

test('failed queries show recorded code and error without a CSV', () => {
  const row = conversationRow({ tool: 'mcp__assay__sql', input: {}, output: 'Query 003 failed: relation missing' }, { '003_bad.sql': 'select * from missing' })
  assert.equal(row.kind, 'run')
  assert.equal(row.error, 'Query 003 failed: relation missing')
})

test('running queries show input SQL before run files exist', () => {
  const row = conversationRow({ tool: 'mcp__assay__sql', input: { sql: 'select 1' }, isRunning: true })
  assert.equal(row.kind, 'run')
  assert.equal(row.running, true)
  assert.equal(row.code, 'select 1')
})

test('missing files, unidentified results and unrelated tools preserve the engine row', () => {
  for (const call of [
    { tool: 'mcp__assay__sql', input: {}, output: 'no number' },
    { tool: 'mcp__assay__sql', input: {}, output: 'Query 001: ok' },
    { tool: 'mcp__assay__python', input: {} },
  ]) assert.deepEqual(conversationRow(call), { kind: 'engine' })
  assert.deepEqual(conversationRow({ tool: 'mcp__assay__sql', input: {}, output: 'Query 001: ok' }, { '001_a.sql': 'select 1' }), { kind: 'engine' })
})

test('malformed MCP blocks never supply a run number', () => {
  for (const output of [null, 1, {}, { content: 'bad' }, { content: [null, 1, {}, { type: 'image' }, { type: 'text', text: 5 }] }]) {
    assert.deepEqual(conversationRow({ tool: 'mcp__assay__sql', input: {}, output }), { kind: 'engine' })
  }
  assert.deepEqual(conversationRow({ tool: 'mcp__assay__sql', input: {}, output: 'Query 001: ok' }, { '001_one.csv': 'n\n1' }), { kind: 'engine' })
  const row = conversationRow({ tool: 'mcp__assay__sql', input: null, isRunning: true })
  assert.equal(row.kind, 'run')
  assert.equal(row.code, '')
})

test('a trusted-include preface still identifies the saved SQL run', () => {
  assert.equal(conversationRow({ tool: 'mcp__assay__sql', input: { sql: 'select 1' }, output: 'Built from: all_sites (block)\nQuery 001: 1 row.' }, {
    '001_one.sql': 'select 1', '001_one.csv': 'n\n1\n',
  }).kind, 'run')
})

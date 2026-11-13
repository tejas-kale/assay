import { expect, test, mock } from 'claude-code/testing'

const ROW = {
  plugin: 'assay', component: 'ToolUse', requestId: 'sql-1', viewport: { columns: 80, rows: 30 },
  props: { tool_use_id: 'sql-1', tool: 'mcp__assay__sql', input: { sql: 'select 1' }, isRunning: false, isErrored: false, isInterrupted: false,
    output: { content: [{ type: 'text', text: 'Query 001: 1 row. Columns: n\nn\n1' }] } },
} as const

test('SQL row shows saved code, author and table on terminal and desktop', async ($, on) => {
  mock.env(on, { ASSAY_ANALYSIS: '/analysis' })
  on('fs.stat', ($, e) => ({ value: { kind: e.path.endsWith('.sql') || e.path.endsWith('.csv') ? 'file' : 'dir', size: 12, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.list', () => ({ value: [{ name: '001_one.sql', kind: 'file', size: 12, isLink: false }, { name: '001_one.csv', kind: 'file', size: 4, isLink: false }] }))
  on('fs.read', ($, e) => ({ value: e.path.endsWith('.sql') ? '-- author: user\nselect 1' : 'n\n1\n' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...ROW, surface })
    expect(await ui.find({ type: 'Text', text: 'Run 1 · user' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: 'select 1', language: 'sql' } })
    expect(await ui.find({ type: 'Text', text: '1 rows · 1 columns' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    await ui.unmount()
  }
})

test('running calls need no file reads and show input code', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const ui = await $.ui.mount({ ...ROW, surface: 'terminal', props: { ...ROW.props, isRunning: true } })
  expect(await ui.find({ type: 'Text', text: 'SQL running' })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: 'select 1' } })
})

test('linked query folders fall back without reading files outside the analysis', async ($, on) => {
  mock.env(on, { ASSAY_ANALYSIS: '/analysis' })
  on('fs.stat', ($, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path === '/analysis' ? '/analysis' : '/other/queries' } }))
  on('fs.read', () => { throw new Error('must not read foreign files') })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const ui = await $.ui.mount({ ...ROW, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
})

test('compact rows hide the engine row while ctrl+o preserves it first', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  for (const isExpanded of [false, true]) {
    const ui = await $.ui.mount({ ...ROW, surface: 'terminal', props: { ...ROW.props, isRunning: true, isExpanded } })
    expect(await ui.find({ type: 'Text', text: 'SQL running' })).toBeDefined()
    if (isExpanded) expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeUndefined()
    await ui.unmount()
  }
})

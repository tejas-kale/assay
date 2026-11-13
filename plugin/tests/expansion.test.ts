import { expect, mock, test } from 'claude-code/testing'

const SQL = Array.from({ length: 45 }, (_, index) => `select ${index};`).join('\n')
const ROW = { plugin: 'assay', component: 'ToolUse', viewport: { columns: 80, rows: 30 }, props: {
  tool: 'mcp__assay__sql', input: { sql: SQL }, output: 'Query 001: 12 rows.', isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false,
} }

test('full-code expansion belongs to one tool row and survives remounting', async ($, on) => {
  mock.env(on, { ASSAY_ANALYSIS: '/analysis' })
  on('fs.stat', ($, e) => ({ value: { kind: e.path.includes('.') ? 'file' : 'directory', size: 10, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.list', () => ({ value: ['001_one.sql', '001_one.csv'].map(name => ({ name, kind: 'file', size: 10, isLink: false })) }))
  on('fs.read', ($, e) => ({ value: e.path.endsWith('.sql') ? SQL : 'n\n' + Array.from({ length: 12 }, (_, i) => String(i)).join('\n') + '\n' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const site = id => ({ ...ROW, surface: 'terminal', requestId: id, props: { ...ROW.props, tool_use_id: id } })
  const first = await $.ui.mount(site('one'))
  const second = await $.ui.mount(site('two'))
  expect(await first.find({ type: 'Code' })).toMatchObject({ props: { source: SQL.split('\n').slice(0, 40).join('\n') } })
  await first.press({ key: 'full-code' })
  expect(await first.find({ type: 'Code' })).toMatchObject({ props: { source: SQL } })
  expect(await second.find({ key: 'full-code' })).toBeDefined()
  await first.press({ key: 'all-rows:001_one.csv' })
  expect(await first.find({ type: 'Markdown' })).toMatchObject({ props: { text: '| n |\n| --- |\n' + Array.from({ length: 12 }, (_, i) => `| ${i} |`).join('\n') } })
  await first.unmount()
  const again = await $.ui.mount(site('one'))
  expect(await again.find({ key: 'full-code' })).toBeUndefined()
  expect(await again.find({ key: 'all-rows:001_one.csv' })).toBeUndefined()
  await again.unmount()
  await second.unmount()
})

test('Read, Grep, Glob and Bash show one quiet summary and expand individually', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine details'] }))
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash']) {
    const props = { tool_use_id: tool, tool, input: { command: 'echo one\necho two', file_path: '/analysis/data.csv' }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false }
    const ui = await $.ui.mount({ plugin: 'assay', component: 'ToolUse', requestId: tool, surface: 'terminal', props })
    expect(await ui.find({ type: 'Text', text: 'engine details' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: tool })).toBeDefined()
    await ui.press({ key: 'details' })
    expect(await ui.find({ type: 'Text', text: 'engine details' })).toBeDefined()
    await ui.unmount()
    const expanded = await $.ui.mount({ plugin: 'assay', component: 'ToolUse', requestId: tool + '-expanded', surface: 'terminal', props: { ...props, tool_use_id: tool + '-expanded', isExpanded: true } })
    expect(await expanded.find({ type: 'Text', text: 'engine details' })).toBeDefined()
    await expanded.unmount()
  }
})

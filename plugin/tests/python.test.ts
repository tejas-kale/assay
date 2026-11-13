import { expect, mock, test } from 'claude-code/testing'

const FILES = {
  '002_plot.py': '# author: user\nprint(42)',
  '002_plot.json': JSON.stringify({ status: 'ok', stdout: '42', tables: [{ file: '002_plot.t1.csv', columns: ['n'], rowCount: 1 }], plots: [{ file: '002_plot.p1.png' }] }),
  '002_plot.t1.csv': 'n\n42\n',
  '002_plot.p1.png': '',
}
const ROW = { plugin: 'assay', component: 'ToolUse', requestId: 'python-2', viewport: { columns: 80, rows: 30 }, props: {
  tool_use_id: 'python-2', tool: 'mcp__assay__python', input: { code: 'print(42)' }, output: { content: [{ type: 'text', text: 'Run 002: ok (0.1 s).' }] },
  isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false,
} }

test('Python rows draw saved code, stdout, tables and plots with a desktop filename fallback', async ($, on) => {
  mock.env(on, { ASSAY_ANALYSIS: '/analysis' })
  on('fs.stat', ($, e) => ({ value: { kind: e.path.includes('.') ? 'file' : 'directory', size: 10, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.list', () => ({ value: Object.keys(FILES).map(name => ({ name, kind: 'file', size: 10, isLink: false })) }))
  on('fs.read', ($, e) => ({ value: FILES[e.path.split('/').at(-1)] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  for (const surface of ['terminal', 'desktop']) {
    const ui = await $.ui.mount({ ...ROW, surface })
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: 'print(42)', language: 'python' } })
    expect(await ui.find({ type: 'Text', text: '42' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 rows · 1 columns' })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/analysis/queries/002_plot.p1.png', format: 'png' }, alt: '002_plot.p1.png' } })
    else expect(await ui.find({ type: 'Text', text: '002_plot.p1.png' })).toBeDefined()
    await ui.unmount()
  }
})

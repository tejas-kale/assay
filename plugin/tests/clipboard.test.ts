import { expect, test, mock } from 'claude-code/testing'

const ROW = {
  plugin: 'assay', component: 'ToolUse', requestId: 'clipboard-1', surface: 'terminal', viewport: { columns: 80, rows: 30 },
  props: { tool_use_id: 'clipboard-1', tool: 'mcp__assay__sql', input: { sql: 'select 1' },
    isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false,
    output: { content: [{ type: 'text', text: 'Query 001: 1 row. Columns: n\nn\n1' }] } },
}

function queryFiles(on, analysis, destination = path => path) {
  mock.env(on, { ASSAY_ANALYSIS: analysis })
  on('fs.stat', ($, e) => ({ value: { kind: /\.(sql|csv|py|json)$/.test(e.path) ? 'file' : 'directory', size: 12, mtimeMs: 0, isLink: false, realPath: destination(e.path) } }))
  on('fs.list', () => ({ value: [{ name: '001_one.sql', kind: 'file', size: 12, isLink: false }, { name: '001_one.csv', kind: 'file', size: 4, isLink: false }] }))
  on('fs.read', ($, e) => ({ value: e.path.endsWith('.sql') ? 'select 1' : 'n\n1\n' }))
}

test('VisiData copies a shell-quoted absolute table path on the pressed surface', async ($, on) => {
  queryFiles(on, "/my data/O'Brien")
  let copied
  let toast
  on('ui.copy', ($, e) => { copied = e; return { value: { isCopied: true } } })
  on('ui.toast', ($, e) => { toast = e.text; return { value: undefined } })
  const ui = await $.ui.mount(ROW)
  await ui.press({ key: 'visidata-0' })
  expect(copied).toMatchObject({ text: "vd '/my data/O'\\''Brien/queries/001_one.csv'", surface: 'terminal' })
  expect(toast).toBe('Copied VisiData command')
})

test('a refused clipboard copy reports the failure', async ($, on) => {
  queryFiles(on, '/analysis')
  let toast
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'clipboard unavailable' } }))
  on('ui.toast', ($, e) => { toast = e.text; return { value: undefined } })
  const ui = await $.ui.mount(ROW)
  await ui.press({ key: 'visidata-0' })
  expect(toast).toBe('Could not copy VisiData command: clipboard unavailable')
})

test('each Python table has its own VisiData button in K order', async ($, on) => {
  const files = {
    '002_tables.py': 'print(42)',
    '002_tables.json': JSON.stringify({ status: 'ok', stdout: '', tables: [
      { file: '002_tables.t2.csv', columns: ['n'], rowCount: 1 },
      { file: '002_tables.t10.csv', columns: ['n'], rowCount: 1 },
    ], plots: [] }),
    '002_tables.t10.csv': 'n\n10\n',
    '002_tables.t2.csv': 'n\n2\n',
  }
  mock.env(on, { ASSAY_ANALYSIS: '/analysis' })
  on('fs.stat', ($, e) => ({ value: { kind: e.path.includes('.') ? 'file' : 'directory', size: 10, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.list', () => ({ value: Object.keys(files).map(name => ({ name, kind: 'file', size: 10, isLink: false })) }))
  on('fs.read', ($, e) => ({ value: files[e.path.split('/').at(-1)] }))
  const copied = []
  on('ui.copy', ($, e) => { copied.push(e.text); return { value: { isCopied: true } } })
  on('ui.toast', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...ROW, props: { ...ROW.props, tool: 'mcp__assay__python', input: { code: 'print(42)' }, output: 'Run 002: ok (0.1 s).' } })
  await ui.press({ key: 'visidata-0' })
  await ui.press({ key: 'visidata-1' })
  expect(copied).toEqual(["vd '/analysis/queries/002_tables.t2.csv'", "vd '/analysis/queries/002_tables.t10.csv'"])
})

test('a table redirected outside the analysis after rendering is refused before copying', async ($, on) => {
  let redirected = false
  queryFiles(on, '/analysis', path => redirected && path.endsWith('.csv') ? '/other/foreign.csv' : path)
  let copied = false
  let toast
  on('ui.copy', () => { copied = true; return { value: { isCopied: true } } })
  on('ui.toast', ($, e) => { toast = e.text; return { value: undefined } })
  const ui = await $.ui.mount(ROW)
  redirected = true
  await ui.press({ key: 'visidata-0' })
  expect(copied).toBe(false)
  expect(toast).toMatch(/^Could not copy VisiData command:/)
})

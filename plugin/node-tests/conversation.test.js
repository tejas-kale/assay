import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundle } from '../../src/testing/bundle.ts'

await bundle()
const { register } = await import('../hooks/conversation.js')
globalThis.h = (element, props, ...children) => element({ ...props, children })
const elements = Object.fromEntries(['Box', 'Text', 'Code', 'Markdown', 'Button', 'Image'].map(type => [type, ({ children, ...props }) => ({ type, props, children })]))
const engine = { type: 'Text', props: {}, children: ['engine'] }

function harness(overrides = {}) {
  const hooks = []
  const byComponent = {}
  register((event, options, handle) => { hooks.push(handle); byComponent[options.component] = handle })
  const state = new Map()
  const notices = []
  const files = { '001_one.sql': '-- author: user\nselect 1', '001_one.csv': 'n\n1\n' }
  const $ = {
    env: { get: name => Promise.resolve(name === 'ASSAY_ANALYSIS' ? '/analysis' : '/backend') },
    fs: {
      stat: path => Promise.resolve({ kind: path.includes('.') ? 'file' : 'directory', realPath: path }),
      list: () => Promise.resolve(Object.keys(files).map(name => ({ name }))),
      read: path => Promise.resolve(files[path.split('/').at(-1)]),
    },
    ui: { resolve: () => elements, toast: text => { notices.push(text) }, copy: () => Promise.resolve({ isCopied: true }) },
    state: { get: ref => Promise.resolve({ value: state.get(ref.id) }), set: (ref, value) => { state.set(ref.id, value); return Promise.resolve({ isSet: true }) } },
    ...overrides,
  }
  const event = { component: 'ToolUse', surface: 'terminal', viewport: { columns: 80, rows: 30 }, props: {
    tool_use_id: 'sql-1', tool: 'mcp__assay__sql', input: { sql: 'select 1' }, output: 'Query 001: 1 row.', isRunning: false, isErrored: false, isExpanded: false,
  } }
  const $hooks = { toolUse: byComponent.ToolUse, toolGroup: byComponent.ToolGroup, toolResult: byComponent.ToolResult }
  return { $, $hooks, event, files, notices, render: e => hooks[0]($, e ?? event, () => Promise.resolve(engine)) }
}

function find(tree, type) {
  if (tree?.type === type) return tree
  return tree?.children?.flat(Infinity).map(child => find(child, type)).find(Boolean)
}

test('the registered renderer draws saved SQL within the viewport and preserves expanded engine content', async () => {
  const ui = harness()
  const tree = await ui.render()
  assert.equal(find(tree, 'Code').props.source, 'select 1')
  assert.equal(tree.props.width, 80)
  assert.match(find(tree, 'Markdown').props.text, /\| n \|/)
  const expanded = await ui.render({ ...ui.event, props: { ...ui.event.props, isExpanded: true } })
  assert.deepEqual(expanded.children[0], engine)
})

test('the registered renderer falls back on unrelated calls, missing roots and read failures', async () => {
  const ui = harness()
  assert.equal(await ui.render({ ...ui.event, props: { ...ui.event.props, tool: 'other' } }), engine)
  const missing = harness({ env: { get: () => Promise.resolve(undefined) } })
  assert.equal(await missing.render(), engine)
  const unreadable = harness({ fs: { stat: () => Promise.reject(new Error('denied')) } })
  assert.equal(await unreadable.render(), engine)
})

test('the renderer refuses linked queries and files outside the open analysis', async () => {
  for (const target of ['queries', '001_one.sql']) {
    const ui = harness()
    ui.$.fs.stat = path => Promise.resolve({ kind: path.includes('.') ? 'file' : 'directory', realPath: path.endsWith(target) ? '/private' : path })
    assert.equal(await ui.render(), engine)
  }
})

test('running and failed rows retain source and error text even without a table', async () => {
  const ui = harness()
  const running = await ui.render({ ...ui.event, viewport: undefined, props: { ...ui.event.props, isRunning: true } })
  assert.equal(find(running, 'Code').props.source, 'select 1')
  assert.equal(running.props.width, 80)
  delete ui.files['001_one.csv']
  const failed = await ui.render({ ...ui.event, props: { ...ui.event.props, output: 'Query 001 failed: bad SQL', isErrored: true } })
  assert.match(JSON.stringify(failed), /bad SQL/)
  assert.equal(await ui.render(), engine)
  assert.equal(await ui.render({ ...ui.event, props: { ...ui.event.props, output: 'No run' } }), engine)
})

test('unknown run numbers and unresolved query roots preserve the original row', async () => {
  const ui = harness()
  assert.equal(await ui.render({ ...ui.event, props: { ...ui.event.props, output: 'Query 999: ok' } }), engine)
  ui.$.fs.stat = () => Promise.resolve({ kind: 'directory' })
  assert.equal(await ui.render(), engine)
})

function keyed(tree, key) {
  if (tree?.props?.key === key) return tree
  return tree?.children?.flat(Infinity).map(child => keyed(child, key)).find(Boolean)
}

test('individual source and table buttons expand their row, while ctrl+o shows all content', async () => {
  const ui = harness()
  ui.files['001_one.sql'] = Array.from({ length: 45 }, (_, i) => `select ${i};`).join('\n')
  ui.files['001_one.csv'] = 'n\n' + Array.from({ length: 12 }, (_, i) => String(i)).join('\n') + '\n'
  const initial = await ui.render()
  await keyed(initial, 'full-code').props.onPress()
  await keyed(initial, 'all-rows:001_one.csv').props.onPress()
  assert.equal(find(await ui.render(), 'Code').props.source, ui.files['001_one.sql'])
  assert.match(find(await ui.render(), 'Markdown').props.text, /\| 11 \|/)
  const expanded = await ui.render({ ...ui.event, props: { ...ui.event.props, tool_use_id: 'fresh', isExpanded: true } })
  assert.equal(keyed(expanded, 'full-code'), undefined)
})

test('quiet rows reveal engine details after a person presses their button', async () => {
  const ui = harness()
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash']) {
    const event = { ...ui.event, props: { ...ui.event.props, tool, tool_use_id: tool, input: { pattern: 'one\ntwo' } } }
    const tree = await ui.render(event)
    assert.match(find(tree, 'Text').children[0], /one two/)
    await keyed(tree, 'details').props.onPress()
    assert.equal(await ui.render(event), engine)
    assert.equal(await ui.render({ ...event, props: { ...event.props, isExpanded: true } }), engine)
  }
})

test('Python rows keep output, checked plot paths and truncated table counts on both surfaces', async () => {
  const ui = harness()
  delete ui.files['001_one.sql']
  delete ui.files['001_one.csv']
  Object.assign(ui.files, {
    '002_plot.py': 'print(42)', '002_plot.json': JSON.stringify({ status: 'ok', stdout: '42', tables: [{ file: '002_plot.t1.csv', rowCount: 100 }], plots: [{ file: '002_plot.p1.png' }, { file: '002_plot.p2.svg' }] }),
    '002_plot.t1.csv': 'n\n1\n', '002_plot.p1.png': '', '002_plot.p2.svg': '',
  })
  const event = { ...ui.event, props: { ...ui.event.props, tool: 'mcp__assay__python', output: 'Run 002: ok' } }
  const terminal = await ui.render(event)
  assert.deepEqual(find(terminal, 'Image').props.source, { file: '/analysis/queries/002_plot.p1.png', format: 'png' })
  assert.match(JSON.stringify(terminal), /1 rows saved of 100/)
  assert.equal(find(await ui.render({ ...event, surface: 'desktop' }), 'Image'), undefined)
})

test('note, diff and thread rows show submitted text and preserve expanded engine content', async () => {
  const ui = harness()
  const cases = [
    { tool: 'mcp__assay__note', input: { title: 'Finding', text: 'Evidence' }, output: 'Wrote notes/one.md' },
    { tool: 'mcp__assay__revise_note', input: { old: 'before', new: 'after' }, output: 'Revised notes/one.md' },
    { tool: 'mcp__assay__revise_note', input: { title: 'Changed' }, output: 'Revised notes/one.md' },
    { tool: 'mcp__assay__revise_note', input: { old: 'before', new: 'a'.repeat(11000) }, output: 'Revised notes/one.md' },
    { tool: 'mcp__assay__close', input: { thread: 'one' }, output: 'Closed: one' },
  ]
  for (const entry of cases) {
    const tree = await ui.render({ ...ui.event, props: { ...ui.event.props, ...entry, isExpanded: true } })
    assert.deepEqual(tree.children[0], engine)
    assert.match(JSON.stringify(tree), new RegExp(entry.output.split(':')[0]))
  }
})

test('VisiData checks the path again and reports clipboard success or failure', async () => {
  const ui = harness()
  const button = keyed(await ui.render(), 'visidata-0')
  await button.props.onPress({ surface: 'terminal' })
  assert.equal(ui.notices.at(-1), 'Copied VisiData command')
  ui.$.ui.copy = () => Promise.resolve({ isCopied: false })
  await button.props.onPress({ surface: 'terminal' })
  assert.match(ui.notices.at(-1), /clipboard unavailable/)
  ui.$.fs.stat = () => Promise.reject(new Error('missing table'))
  await button.props.onPress({ surface: 'terminal' })
  assert.match(ui.notices.at(-1), /missing table/)
})

test('quiet rows handle missing details and linked clipboard targets fail after rendering', async () => {
  const ui = harness()
  for (const input of [null, {}, { file_path: '/data' }, { path: '/root' }, { command: 42 }]) {
    const tree = await ui.render({ ...ui.event, viewport: undefined, props: { ...ui.event.props, tool: 'Read', input } })
    assert.equal(tree.props.width, 80)
  }
  const button = keyed(await ui.render(), 'visidata-0')
  ui.$.fs.stat = path => Promise.resolve({ kind: 'file', realPath: path.endsWith('.csv') ? '/private' : path })
  await button.props.onPress({ surface: 'terminal' })
  assert.match(ui.notices.at(-1), /outside the open analysis/)
  ui.$.env.get = () => Promise.resolve(undefined)
  await button.props.onPress({ surface: 'terminal' })
  assert.match(ui.notices.at(-1), /unavailable/)
})

test('compact quiet calls preserve engine failures and show when work is still running', async () => {
  const ui = harness()
  for (const status of [{ isErrored: true }, { isInterrupted: true }]) {
    assert.equal(await ui.render({ ...ui.event, props: { ...ui.event.props, tool: 'Bash', ...status } }), engine)
  }
  const tree = await ui.render({ ...ui.event, props: { ...ui.event.props, tool: 'Bash', isRunning: true } })
  assert.match(JSON.stringify(tree), /Running/)
})

const SCHEMA = 'COLUMNS:\n  id: bigint\n  name: string\n  seen: 2026-11-13\n  ok: true'

test('expanded Bash output that reads as key: value lines is drawn in colour once, under the engine row', async () => {
  const ui = harness()
  const seen = []
  const props = { ...ui.event.props, tool: 'Bash', tool_use_id: 'bash', isExpanded: true, output: { stdout: SCHEMA, stderr: '' } }
  const tree = await ui.$hooks.toolUse(ui.$, { ...ui.event, props }, e => { seen.push(e.props.output); return Promise.resolve(engine) })
  assert.deepEqual(seen, [undefined])
  assert.deepEqual(tree.children[0], engine)
  assert.match(JSON.stringify(tree), /"color":"suggestion".*"id"/)
  assert.match(JSON.stringify(tree), /"color":"merged".*"bigint"/)
  assert.equal((await ui.$hooks.toolResult(ui.$, { props }, () => engine)).type, 'Box')
  for (const output of [{ stdout: 'plain text', stderr: '' }, { stdout: SCHEMA, stderr: 'warning' }, 'text', null, { stdout: 1 }]) {
    const other = { ...props, output }
    assert.equal(await ui.$hooks.toolUse(ui.$, { ...ui.event, props: other }, () => Promise.resolve(engine)), engine)
    assert.equal(await ui.$hooks.toolResult(ui.$, { props: other }, () => engine), engine)
  }
  const errored = { ...props, isErrored: true }
  assert.equal(await ui.$hooks.toolResult(ui.$, { props: errored }, () => engine), engine)
})

test('a folded group with a sql or python call is shown call by call', async () => {
  const ui = harness()
  const group = calls => ({ props: { calls: calls.map(tool => ({ tool })), isExpanded: false } })
  assert.equal(ui.$hooks.toolGroup(ui.$, group(['Read', 'mcp__assay__python']), e => e).props.isExpanded, true)
  assert.equal(ui.$hooks.toolGroup(ui.$, group(['Read', 'Bash']), e => e).props.isExpanded, false)
  const open = { props: { calls: [{ tool: 'mcp__assay__sql' }], isExpanded: true } }
  assert.equal(ui.$hooks.toolGroup(ui.$, open, e => e), open)
})

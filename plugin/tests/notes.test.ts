import { expect, test } from 'claude-code/testing'

const ROW = {
  plugin: 'assay', component: 'ToolUse', requestId: 'note-1', surface: 'terminal', viewport: { columns: 80, rows: 30 },
  props: { tool_use_id: 'note-1', tool: 'mcp__assay__note', input: { title: 'Finding', text: '**Seven** sites.' },
    isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false,
    output: { content: [{ type: 'text', text: 'Wrote notes/20261112T120000-finding.md.' }] } },
}

test('a note renders its submitted Markdown and preserves the server acknowledgement', async ($) => {
  const ui = await $.ui.mount(ROW)
  expect(await ui.find({ type: 'Markdown' })).toMatchObject({ props: { text: '# Finding\n\n**Seven** sites.\n' } })
  expect(await ui.find({ type: 'Text', text: 'Wrote notes/20261112T120000-finding.md.' })).toBeDefined()
})

test('a revision draws replacement hunks as a coloured diff', async ($) => {
  const ui = await $.ui.mount({ ...ROW, props: { ...ROW.props, tool: 'mcp__assay__revise_note', input: { id: '20261112T120000', old: 'Seven sites.', new: 'Eight sites.' }, output: 'Revised notes/20261112T120000-finding.md.' } })
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: '@@ -1,1 +1,1 @@\n-Seven sites.\n+Eight sites.', format: 'diff' } })
})

test('a revision without a parseable diff draws plain text', async ($) => {
  const ui = await $.ui.mount({ ...ROW, props: { ...ROW.props, tool: 'mcp__assay__revise_note', input: { id: '20261112T120000', title: 'New title' }, output: 'Revised notes/20261112T120000-finding.md.' } })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Revised notes/20261112T120000-finding.md.' })).toBeDefined()
})

test('each thread and note housekeeping tool draws one summary line', async ($) => {
  const cases = [
    ['park', { thread: 'Why seven?' }, 'Parked. 1 open thread.', 'Parked: Why seven? · Parked. 1 open thread.'],
    ['close', { thread: '1' }, 'Closed "Why seven?". No open threads left.', 'Closed "Why seven?". No open threads left.'],
    ['focus', { thread: '2' }, 'Focused: 1. Why seven?', 'Focused: 1. Why seven?'],
    ['order', { threads: ['2', '1'] }, 'Open threads now:\n1. Why seven?\n2. Which sites?', 'Open threads now: 1. Why seven? · 2. Which sites?'],
    ['link_notes', { ids: ['20261112T120000'] }, 'Linked 20261112T120000 Finding.', 'Linked 20261112T120000 Finding.'],
    ['note_labels', {}, '20261112T120000 Finding\n[alpha q 1] missing', '20261112T120000 Finding · [alpha q 1] missing'],
  ]
  for (const [tool, input, output, text] of cases) {
    const ui = await $.ui.mount({ ...ROW, requestId: tool, props: { ...ROW.props, tool: `mcp__assay__${tool}`, input, output } })
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
    await ui.unmount()
  }
})

test('a large replacement stays visible as plain text when it exceeds the Code element limit', async ($) => {
  const old = 'old line\n'.repeat(800)
  const next = 'new line\n'.repeat(800)
  const ui = await $.ui.mount({ ...ROW, props: { ...ROW.props, tool: 'mcp__assay__revise_note', input: { old, new: next }, output: 'Revised notes/20261112T120000-finding.md.' } })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Revised notes/20261112T120000-finding.md.' })).toBeDefined()
})

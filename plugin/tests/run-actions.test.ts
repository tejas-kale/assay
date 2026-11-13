import { expect, mock, test } from 'claude-code/testing'

test('saved-run buttons send only their explicit action to the bundled request writer', async ($, on) => {
  mock.env(on, { ASSAY_ANALYSIS: '/analysis', ASSAY_BACKEND: '/backend with spaces' })
  on('fs.stat', ($, e) => ({ value: { kind: e.path.endsWith('.sql') || e.path.endsWith('.csv') ? 'file' : 'dir', size: 12, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.list', () => ({ value: [{ name: '007_sites.sql', kind: 'file', size: 12, isLink: false }, { name: '007_sites.csv', kind: 'file', size: 4, isLink: false }] }))
  on('fs.read', ($, e) => ({ value: e.path.endsWith('.sql') ? 'select 7' : 'n\n7\n' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const calls: { argv: readonly string[]; init: unknown }[] = []
  const toasts: string[] = []
  on('process.run', ($, e) => {
    calls.push({ argv: e.argv, init: e.init })
    return { value: { exitCode: 0, stdout: '{"ok":true,"id":"request-7"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  const ui = await $.ui.mount({ plugin: 'assay', surface: 'terminal', component: 'ToolUse', props: { tool_use_id: 'run-7', tool: 'mcp__assay__sql', input: { sql: 'select 7' }, output: { content: [{ type: 'text', text: 'Query 007: 1 row.' }] }, isRunning: false, isErrored: false, isInterrupted: false } })
  expect(calls).toEqual([])
  await ui.press({ key: 'edit:run-7' })
  await ui.press({ key: 'rerun:run-7' })
  expect(calls).toEqual([
    { argv: ['node', '/backend with spaces/out/cli/run-action.mjs'], init: { stdin: '{"action":"edit","file":"007_sites.sql"}', timeoutMs: 600000 } },
    { argv: ['node', '/backend with spaces/out/cli/run-action.mjs'], init: { stdin: '{"action":"rerun","file":"007_sites.sql"}', timeoutMs: 600000 } },
  ])
  expect(toasts).toEqual(['Queued a new user run.', 'Queued a new user run.'])
})

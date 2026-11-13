import { expect, test } from 'claude-code/testing'
import { actionButtons, actionMessage, actionRequest } from '../hooks/conversation-actions.js'

test('request commands preserve saved filenames and give the editor ten minutes', () => {
  expect(actionRequest(undefined, 'edit', '007_sites.sql')).toEqual({ error: 'ASSAY_BACKEND is missing; no run was sent.' })
  expect(actionRequest('/backend with spaces', 'edit', '007_sites.sql')).toEqual({
    argv: ['node', '/backend with spaces/out/cli/run-action.mjs'],
    options: { stdin: '{"action":"edit","file":"007_sites.sql"}', timeoutMs: 600000 },
  })
})

test('action feedback distinguishes queued runs, unchanged edits and submission failures', () => {
  expect(actionMessage({ exitCode: 0, stdout: '{"ok":true,"id":"request-1"}' })).toBe('Queued a new user run.')
  expect(actionMessage({ exitCode: 0, stdout: '{"ok":true,"unchanged":true}' })).toBe('No changes; no run was sent.')
  expect(actionMessage({ exitCode: 0, stdout: '{"ok":false,"message":"queries is not a real folder"}' })).toBe('queries is not a real folder')
  expect(actionMessage({ exitCode: 1, stderr: 'node failed' })).toBe('node failed')
  expect(actionMessage({ exitCode: 0, stdout: '{}' })).toBe('The request helper returned no result.')
  expect(actionMessage({ exitCode: 0, stdout: 'bad' })).toBe('The request helper returned an unreadable result.')
})

test('saved rows show edit and re-run buttons without submitting a run', async ($, on) => {
  const submitted: { action: string; file: string }[] = []
  on('ui.render', ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    const buttons = actionButtons({ Button, row: { running: false, file: '007_sites.sql' }, id: 'run-7', submit: (action: string, file: string) => { submitted.push({ action, file }) } })
    return h(Box, {}, ...buttons)
  })
  const ui = await $.ui.mount({ plugin: 'assay', surface: 'terminal', component: 'ToolUse', props: { tool_use_id: 'run-7', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false } })
  expect(submitted).toEqual([])
  expect(await ui.find({ key: 'edit:run-7' })).toMatchObject({ type: 'Button', text: 'edit' })
  expect(await ui.find({ key: 'rerun:run-7' })).toMatchObject({ type: 'Button', text: 're-run' })
})

test('running calls and rows without saved files offer no edit or re-run buttons', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    return h(Box, {},
      ...actionButtons({ Button, row: { running: true, file: '007_sites.sql' }, id: 'running', submit: () => {} }),
      ...actionButtons({ Button, row: { running: false }, id: 'missing', submit: () => {} }))
  })
  const ui = await $.ui.mount({ plugin: 'assay', surface: 'terminal', component: 'ToolUse', props: { tool_use_id: 'run-7', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false } })
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
})

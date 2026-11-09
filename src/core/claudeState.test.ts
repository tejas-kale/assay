import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CLAUDE_STATE, claudeStateFile, claudeStateForHook, readClaudeState } from './claudeState.ts'

const hook = (hook_event_name: string, more: Record<string, unknown> = {}) => ({ hook_event_name, ...more })

test('a submitted prompt and a finished tool call mean Claude is working', () => {
  assert.equal(claudeStateForHook(hook('UserPromptSubmit', { prompt: 'hi' })), 'working')
  assert.equal(claudeStateForHook(hook('PostToolUse', { tool_name: 'Bash' })), 'working')
})

test('a permission prompt, a question dialog, or Claude asking a question means it is waiting for you', () => {
  assert.equal(claudeStateForHook(hook('Notification', { notification_type: 'permission_prompt' })), 'waiting')
  assert.equal(claudeStateForHook(hook('Notification', { notification_type: 'elicitation_dialog' })), 'waiting')
  assert.equal(claudeStateForHook(hook('Notification', { message: 'Claude needs your permission to use Bash' })), 'waiting')
  assert.equal(claudeStateForHook(hook('PreToolUse', { tool_name: 'AskUserQuestion' })), 'waiting')
})

test('a finished turn means idle', () => {
  assert.equal(claudeStateForHook(hook('Stop')), 'idle')
})

test('the 60-second idle reminder and other events change nothing', () => {
  assert.equal(claudeStateForHook(hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })), undefined)
  assert.equal(claudeStateForHook(hook('SubagentStop')), undefined)
  assert.equal(claudeStateForHook(hook('PreToolUse', { tool_name: 'Bash' })), undefined)
  assert.equal(claudeStateForHook({}), undefined)
})

test('the state file lives in the analysis .assay folder and reads back what was written', () => {
  assert.equal(CLAUDE_STATE, '.assay/claude.json')
  for (const state of ['working', 'waiting', 'idle'] as const) {
    assert.equal(readClaudeState(claudeStateFile(state, new Date('2026-11-09T12:00:00Z'))), state)
  }
})

test('a missing, half-written or unknown state file reads as idle', () => {
  assert.equal(readClaudeState(undefined), 'idle')
  assert.equal(readClaudeState('{"state": "wor'), 'idle')
  assert.equal(readClaudeState('{"state": "dancing"}'), 'idle')
})

// What Claude is doing in an analysis, for the analysis strip. The plugin's hooks write it to CLAUDE_STATE in the
// analysis folder; main polls that file. `waiting` means Claude needs an answer from you (a permission prompt or a
// question); `idle` means its turn is over.

export type ClaudeState = 'working' | 'waiting' | 'idle'

/** Relative to the analysis folder. */
export const CLAUDE_STATE = '.assay/claude.json'

const STATES: readonly ClaudeState[] = ['working', 'waiting', 'idle']
const WAITING_NOTIFICATIONS = ['permission_prompt', 'elicitation_dialog']

const text = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? input[key] : '')

/** The state a hook event moves Claude to, or undefined when the event says nothing about it. */
export function claudeStateForHook(input: Record<string, unknown>): ClaudeState | undefined {
  switch (text(input, 'hook_event_name')) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working'
    case 'PreToolUse':
      return text(input, 'tool_name') === 'AskUserQuestion' ? 'waiting' : undefined
    case 'Notification': {
      const type = text(input, 'notification_type')
      if (type) return WAITING_NOTIFICATIONS.includes(type) ? 'waiting' : undefined
      // Before notification_type existed, only the message told a permission prompt apart.
      return /permission/i.test(text(input, 'message')) ? 'waiting' : undefined
    }
    case 'Stop':
      return 'idle'
    default:
      return undefined
  }
}

export const claudeStateFile = (state: ClaudeState, now: Date) => `${JSON.stringify({ state, at: now.toISOString() })}\n`

/** The state in the file's text; idle when there is no file yet or it cannot be read. */
export function readClaudeState(fileText: string | undefined): ClaudeState {
  if (fileText === undefined) return 'idle'
  try {
    const parsed: unknown = JSON.parse(fileText)
    const state = parsed && typeof parsed === 'object' ? (parsed as { state?: unknown }).state : undefined
    return STATES.find(s => s === state) ?? 'idle'
  } catch {
    return 'idle'
  }
}

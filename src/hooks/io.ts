// What every hook script shares: read the hook's JSON from stdin, print a JSON answer. A hook that has nothing to
// say prints nothing and exits 0, which lets the call or prompt through unchanged.

export async function readInput(): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export const field = (input: Record<string, unknown>, key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')

/** The tool input of a PreToolUse hook. */
export const toolInput = (input: Record<string, unknown>): Record<string, unknown> =>
  input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>) : {}

/** PreToolUse: refuse the call, with the reason Claude reads. */
export const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

/** UserPromptSubmit: text added to the prompt's context. */
export const addContext = (text: string) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })

export function answer(body: object | undefined) {
  if (body) process.stdout.write(`${JSON.stringify(body)}\n`)
}

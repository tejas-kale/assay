// Keys the terminal rewrites before they reach the pty.

type KeyLike = { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }

/** Claude Code reads ESC then CR (what Option+Enter sends) as a newline, where a bare CR sends the prompt. */
export const NEWLINE_INPUT = '\x1b\r'

/** What to send instead of the key's usual input, or `undefined` to leave the key alone. Only Shift+Enter is rewritten. */
export const inputOverride = (e: KeyLike): string | undefined =>
  e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey ? NEWLINE_INPUT : undefined

/**
 * Whether the terminal must let the key go so the app menu can run it (Cmd+Q, Cmd+H, Cmd+, ...).
 * The terminal library encodes Cmd+letter as the bare letter and swallows it.
 * Cmd with Backspace or an arrow stays with the terminal for line editing.
 */
export const leavesTerminal = (e: KeyLike): boolean => e.metaKey && !e.ctrlKey && e.key.length === 1

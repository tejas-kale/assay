// Keys the terminal rewrites before they reach the pty.

type KeyLike = { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }

/** Claude Code reads ESC then CR (what Option+Enter sends) as a newline, where a bare CR sends the prompt. */
export const NEWLINE_INPUT = '\x1b\r'

/**
 * Ctrl+V as a terminal sends it. Claude Code reads an image from the clipboard on this byte. The terminal
 * library takes Ctrl+V as a browser paste and sends nothing, so the byte is sent from here.
 */
export const CTRL_V_INPUT = '\x16'

/** What to send instead of the key's usual input, or `undefined` to leave the key alone. Shift+Enter and Ctrl+V are rewritten. */
export function inputOverride(e: KeyLike): string | undefined {
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return NEWLINE_INPUT
  if (e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return CTRL_V_INPUT
  return undefined
}

/**
 * Whether the terminal must let the key go so the app menu can run it (Cmd+Q, Cmd+H, Cmd+, ...).
 * The terminal library encodes Cmd+letter as the bare letter and swallows it.
 * Cmd with Backspace or an arrow stays with the terminal for line editing.
 */
export const leavesTerminal = (e: KeyLike): boolean => e.metaKey && !e.ctrlKey && e.key.length === 1

/** Wheel scrolling as a pixel delta per line, the same divisor the terminal library uses. */
export const WHEEL_PIXELS_PER_LINE = 33
const WHEEL_MAX_LINES = 5

/**
 * Lines to scroll for a wheel event, carrying the remainder so a trackpad's small deltas add up.
 * Returns `[lines, remainder]`; lines is negative for up.
 */
export function wheelLines(deltaY: number, carried: number): [number, number] {
  const total = carried + deltaY / WHEEL_PIXELS_PER_LINE
  const whole = Math.trunc(total)
  const lines = Math.max(-WHEEL_MAX_LINES, Math.min(WHEEL_MAX_LINES, whole))
  return [lines, total - whole]
}

/**
 * Mouse wheel reports for a program that turned mouse tracking on (Claude Code does in its full-screen
 * view). The library sends arrow keys instead, which Claude reads as history navigation. `col` and
 * `row` are 1-based. SGR (mode 1006) when the program asked for it, else the legacy X10 bytes.
 */
export function wheelReport(lines: number, col: number, row: number, sgr: boolean): string {
  const button = lines < 0 ? 64 : 65
  const one = sgr
    ? `\x1b[<${String(button)};${String(col)};${String(row)}M`
    : `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`
  return one.repeat(Math.abs(lines))
}

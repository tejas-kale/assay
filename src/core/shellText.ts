// Text-level shell rules applied before the Bash guard parses a command: line continuations and heredoc bodies.

const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/
const COMMENT_BEFORE = /^[\s;&|(]?$/

/** Whether the `#` at `i` starts a comment: at the start of a word, and not right after an escaped space. */
const startsComment = (text: string, i: number) => COMMENT_BEFORE.test(text[i - 1] ?? '') && text[i - 2] !== '\\'

/** The text of a comment from `i` to its line's end (the newline excluded). */
const commentAt = (text: string, i: number) => text.slice(i, text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i))

/**
 * The command with backslash-newline pairs removed, as bash does, except inside single quotes and comments. A
 * backslash pair is copied whole, so the newline after an escaped backslash stays.
 */
export function joinContinuations(command: string): string {
  let out = ''
  let isSingle = false
  let i = 0
  while (i < command.length) {
    const char = command[i] ?? ''
    const next = command[i + 1] ?? ''
    let piece = char
    if (isSingle) isSingle = char !== "'"
    else if (char === "'") isSingle = true
    else if (char === '#' && startsComment(command, i)) piece = commentAt(command, i)
    else if (char === '\\') piece = next === '\n' ? '' : char + next
    out += piece
    i += char === '\\' && !isSingle ? 2 : Math.max(piece.length, 1)
  }
  return out
}

/**
 * The command's lines without heredoc bodies: after a `<<WORD` line, everything up to the line that is WORD. A body
 * that is not quoted still runs its substitutions, so `keepUnquoted` leaves those in.
 */
export function withoutHeredocBodies(command: string, keepUnquoted = false): string {
  const lines = command.split('\n')
  const kept: string[] = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at] ?? ''
    kept.push(line)
    at++
    const heredoc = HEREDOC_START.exec(line)
    if (!heredoc || line.includes('<<<')) continue
    const end = lines.findIndex((body, k) => k >= at && body.trim() === heredoc[2])
    const stop = end < 0 ? lines.length : end
    if (keepUnquoted && heredoc[1] === '') kept.push(...lines.slice(at, Math.min(stop + 1, lines.length)))
    at = stop + 1
  }
  return kept.join('\n')
}

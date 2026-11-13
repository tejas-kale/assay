// Note rows use the tool's submitted text: the server acknowledges writes without returning the note body.
import { noteText } from './rootNotes.ts'

export type ConversationNoteCall = { tool: string; input: unknown; output?: unknown; isRunning?: boolean; isErrored?: boolean }
export type NoteDiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }
export type ConversationNoteRow =
  | { kind: 'engine' }
  | { kind: 'thread'; text: string }
  | { kind: 'note'; markdown: string; text: string }
  | { kind: 'noteDiff'; text: string; diff: string; hunks: NoteDiffHunk[] }

export function conversationNoteRow(call: ConversationNoteCall): ConversationNoteRow {
  if (call.isRunning || call.isErrored || typeof call.input !== 'object' || call.input === null) return { kind: 'engine' }
  const input = call.input as Record<string, unknown>
  const text = typeof call.output === 'string' ? call.output : ''
  if (!text.trim()) return { kind: 'engine' }
  if (call.tool === 'mcp__assay__note' && text.startsWith('Wrote notes/') && typeof input.title === 'string' && typeof input.text === 'string') {
    return { kind: 'note', markdown: noteText(input.title, input.text), text }
  }
  if (call.tool === 'mcp__assay__revise_note' && text.startsWith('Revised notes/') && typeof input.old === 'string' && typeof input.new === 'string') {
    const old = input.old.split('\n')
    const next = input.new.split('\n')
    const lines = replacementLines(old, next)
    const diff = [`@@ -1,${String(old.length)} +1,${String(next.length)} @@`, ...lines].join('\n')
    return { kind: 'noteDiff', text, diff, hunks: parseNoteDiff(diff) ?? [] }
  }
  if (call.tool === 'mcp__assay__revise_note' && /^(?:Revised|Deleted) notes\//.test(text)) return { kind: 'noteDiff', text, diff: text, hunks: [] }
  if (['mcp__assay__park', 'mcp__assay__close', 'mcp__assay__focus', 'mcp__assay__order', 'mcp__assay__link_notes', 'mcp__assay__note_labels'].includes(call.tool)) {
    const summary = text.replace(/:\n/, ': ').split('\n').filter(Boolean).join(' · ')
    const thread = typeof input.thread === 'string' ? input.thread.replace(/\s+/g, ' ').trim() : ''
    return { kind: 'thread', text: call.tool === 'mcp__assay__park' && text.startsWith('Parked.') ? `Parked: ${thread} · ${summary}` : summary }
  }
  return { kind: 'engine' }
}

/** Replacement hunks are relative to the supplied excerpt, never fabricated locations in the full note. */
export function parseNoteDiff(diff: string): NoteDiffHunk[] | undefined {
  const hunks: NoteDiffHunk[] = []
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line)
    if (header) {
      hunks.push({ oldStart: Number(header[1]), oldCount: Number(header[2]), newStart: Number(header[3]), newCount: Number(header[4]), lines: [] })
    } else {
      const hunk = hunks.at(-1)
      if (!hunk || !/^[ +-]/.test(line)) return undefined
      hunk.lines.push(line)
    }
  }
  return hunks.length > 0 && hunks.every(validHunk) ? hunks : undefined
}

function validHunk(hunk: NoteDiffHunk): boolean {
  const oldLines = hunk.lines.filter(line => !line.startsWith('+')).length
  const newLines = hunk.lines.filter(line => !line.startsWith('-')).length
  return hunk.lines.length > 0 && oldLines === hunk.oldCount && newLines === hunk.newCount
}


/** Common boundary lines remain context; only the changed middle of the supplied excerpt is replaced. */
function replacementLines(old: string[], next: string[]): string[] {
  let start = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start++
  let end = 0
  while (end < old.length - start && end < next.length - start && old.at(-1 - end) === next.at(-1 - end)) end++
  return [
    ...old.slice(0, start).map(line => ` ${line}`),
    ...old.slice(start, old.length - end).map(line => `-${line}`),
    ...next.slice(start, next.length - end).map(line => `+${line}`),
    ...old.slice(old.length - end).map(line => ` ${line}`),
  ]
}

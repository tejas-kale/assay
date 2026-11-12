// What the Threads tab lists and what its keys mean; the component only draws and sends.
import type { ClosedThread, Threads } from './threads.ts'

/** `index` is the position in threads.open or threads.closed, which is what edits take. */
export type ThreadItem =
  | { kind: 'open'; index: number; text: string }
  | { kind: 'closed'; index: number; text: string; closed: ClosedThread }

/** Open threads, then the closed ones when `unfolded`; a closed thread's text includes its outcome, for filtering. */
export function threadItems(threads: Threads, unfolded: boolean): ThreadItem[] {
  const open = threads.open.map((text, index): ThreadItem => ({ kind: 'open', index, text }))
  const closed = (unfolded ? threads.closed : []).map(
    (item, index): ThreadItem => ({ kind: 'closed', index, closed: item, text: item.outcome ? `${item.thread} ${item.outcome}` : item.thread }),
  )
  return [...open, ...closed]
}

/** What Tab shows in full: a thread, and under a closed one its outcome. */
export function threadPopupText(item: ThreadItem): string {
  if (item.kind === 'open') return item.text
  const { thread, outcome } = item.closed
  return outcome ? `${thread}\n\n→ ${outcome}` : thread
}

export type ThreadCommand = 'add' | 'toggleClosed' | 'edit' | 'close' | 'delete' | 'moveDown' | 'moveUp'

const THREAD_KEYS: Record<string, ThreadCommand> = { a: 'add', z: 'toggleClosed', e: 'edit', c: 'close', d: 'delete', J: 'moveDown', K: 'moveUp' }

export function threadCommand(key: string): ThreadCommand | undefined {
  return Object.hasOwn(THREAD_KEYS, key) ? THREAD_KEYS[key] : undefined
}

/** Where the selection goes when an open thread moves `delta` places, kept inside the open threads. */
export function movedSelection(index: number, delta: number, openCount: number): number {
  return Math.max(0, Math.min(index + delta, openCount - 1))
}

/** Folding the closed threads with one selected moves the selection to the last open one; otherwise it stays (undefined). */
export function selectionAfterFold(selected: ThreadItem | undefined, openCount: number): number | undefined {
  return selected?.kind === 'closed' ? Math.max(0, openCount - 1) : undefined
}

export function sectionHeading(kind: ThreadItem['kind'], closedCount: number): string {
  return kind === 'open' ? 'Open' : `Closed ${String(closedCount)} · z hide`
}

// What the note reader and editor decide: where Tab moves, what a key does, what following a link or a citation does.
// The components carry these out.
import type { CitationLabel } from './citationLabels.ts'
import { citationAction } from './notesView.ts'
import type { NoteTarget, RootNote } from './rootNotes.ts'

export const padRunNumber = (n: number) => String(n).padStart(3, '0')

/** What a key does in the reader, by name; undefined for a key the reader leaves alone. */
export type ReaderCommand = 'next-target' | 'previous-target' | 'follow' | 'back' | 'leave' | 'edit' | 'scroll-down' | 'scroll-up'

const READER_KEYS: Record<string, ReaderCommand | undefined> = {
  Enter: 'follow',
  Backspace: 'back',
  Escape: 'leave',
  e: 'edit',
  j: 'scroll-down',
  k: 'scroll-up',
}

export function readerCommand(key: string, shift: boolean): ReaderCommand | undefined {
  if (key === 'Tab') return shift ? 'previous-target' : 'next-target'
  return Object.hasOwn(READER_KEYS, key) ? READER_KEYS[key] : undefined
}

/** The target Tab moves to from `current` (-1: none yet), wrapping around `count` targets. */
export function cycleTarget(current: number, forward: boolean, count: number): number {
  return ((forward ? current + 1 : current - 1) + count) % count
}

export type FollowResult =
  | { type: 'open-note'; name: string }
  | { type: 'show-run'; number: number }
  | { type: 'read-run'; analysis: string; number: number }
  | { type: 'flash'; text: string }

type FollowContext = {
  notes: readonly RootNote[]
  /** The open analysis's slug. */
  slug: string
  labels: ReadonlyMap<string, CitationLabel>
  /** The numbers of the open analysis's runs. */
  runNumbers: readonly number[]
}

/** What following `target` does: open a note, hold a run in the data pane, read another analysis's run, or say what is missing. */
export function followTarget(target: NoteTarget, { notes, slug, labels, runNumbers }: FollowContext): FollowResult {
  if (target.type === 'link') {
    const found = notes.find(n => n.id === target.id)
    return found ? { type: 'open-note', name: found.name } : { type: 'flash', text: `No note ${target.id}` }
  }
  const action = citationAction(target, slug, labels)
  if (action.type === 'missing') return { type: 'flash', text: missingRun(target.analysis, target.number) }
  if (action.type === 'preview') return { type: 'read-run', analysis: action.analysis, number: action.number }
  if (runNumbers.includes(action.number)) return { type: 'show-run', number: action.number }
  return { type: 'flash', text: `No run ${padRunNumber(action.number)}` }
}

/** The line shown when another analysis's cited run cannot be read. */
export const missingRun = (analysis: string, number: number) => `No run ${analysis} q ${padRunNumber(number)}`

/** What a key does in the editor, which `editorKey` decides; `none` still takes the key from the editor. */
export type EditorKeyAction = 'none' | 'leave-and-close-prompt' | 'close-prompt' | 'save' | 'leave-or-ask'

type KeyInfo = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }

/**
 * The editor's key rules: while the discard prompt is up every key is its own (y leaves, n or Esc dismisses it);
 * otherwise Cmd+S saves, and Esc in Vim normal mode (`atRest`) leaves, asking first if there is unsaved text.
 * undefined: the key is not the editor wrapper's, and Vim gets it.
 */
export function editorKey(e: KeyInfo, prompting: boolean, atRest: boolean): EditorKeyAction | undefined {
  if (prompting) {
    if (e.key === 'y') return 'leave-and-close-prompt'
    return e.key === 'n' || e.key === 'Escape' ? 'close-prompt' : 'none'
  }
  if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === 's') return 'save'
  if (e.key === 'Escape' && atRest) return 'leave-or-ask'
  return undefined
}

/** What the user is told after the file changed on disk under an edit: whether their text reached the clipboard. */
export const staleEditMessage = (copied: boolean) =>
  copied ? 'Changed on disk, reloaded. Your edit is on the clipboard.' : 'Changed on disk, reloaded. Your edit could not be copied.'

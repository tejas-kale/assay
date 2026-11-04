// What the Notes tab and the reader show of root notes: the two groups, link titles, citation text and actions.
import type { CitationLabel } from './citationLabels.ts'
import { citationKey } from './citationLabels.ts'
import type { Citation, NoteLists, RootNote } from './rootNotes.ts'

export type NoteGroups = { written: RootNote[]; found: RootNote[] }

/** Newest first: IDs are timestamps. */
const newestFirst = (a: RootNote, b: RootNote) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** The notes an analysis wrote and found, each newest first. A listed ID with no file is left out. */
export function noteGroups(all: readonly RootNote[], lists: NoteLists): NoteGroups {
  const byId = new Map(all.map(note => [note.id, note]))
  const pick = (ids: readonly string[]) => ids.flatMap(id => byId.get(id) ?? []).sort(newestFirst)
  return { written: pick(lists.written), found: pick(lists.found.filter(id => !lists.written.includes(id))) }
}

/** The tab label: `Notes` with the number of notes the analysis wrote or found. */
export function notesTabLabel(groups: NoteGroups): string {
  const count = groups.written.length + groups.found.length
  return count > 0 ? `Notes (${count})` : 'Notes'
}

/** The title a `[[ID]]` link shows; undefined when no note has that ID. */
export const linkTitle = (id: string, all: readonly RootNote[]) => all.find(note => note.id === id)?.title

const pad = (n: number) => String(n).padStart(3, '0')

/** How a citation reads: `q 012` in the open analysis, `churn-q3 q 012` elsewhere. */
export const citationText = (citation: Citation, openSlug: string) => `${citation.analysis === openSlug ? '' : `${citation.analysis} `}q ${pad(citation.number)}`

export type CitationAction = { type: 'focus'; number: number } | { type: 'preview'; analysis: string; number: number } | { type: 'missing' }

/**
 * What following a citation does: focus the run in the open analysis, open a preview of another analysis's
 * run, or nothing for a missing run.
 */
export function citationAction(citation: Citation, openSlug: string, labels: ReadonlyMap<string, CitationLabel>): CitationAction {
  if (labels.get(citationKey(citation)) === 'missing') return { type: 'missing' }
  return citation.analysis === openSlug ? { type: 'focus', number: citation.number } : { type: 'preview', analysis: citation.analysis, number: citation.number }
}

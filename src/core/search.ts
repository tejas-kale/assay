// Universal search: one list of the open analysis (threads, runs, files) and every root note, matched by
// name with fuzzyRank and by body (note text, run code) as written.
import type { FileEntry } from './files.ts'
import { fuzzyRank } from './fuzzy.ts'
import type { RootNote } from './rootNotes.ts'
import { parseRuns } from './runs.ts'
import type { Run } from './runs.ts'
import type { Threads } from './threads.ts'

/** Where a hit lives, so the app can show it in its own tab. `index` is the position in threads.open or threads.closed. */
export type SearchTarget =
  | { kind: 'thread'; closed: boolean; index: number }
  | { kind: 'note'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'run'; number: number }

/** What a preview shows: a file in the analysis folder (relative path), or text the app already holds. */
export type PreviewSource = { type: 'path'; path: string } | { type: 'text'; text: string; language?: 'sql' | 'python' }

/** The text of every root note and each run's code, read by main for body search. */
export type SearchContents = { notes: { name: string; text: string }[]; runs: { number: number; code: string }[] }

export type SearchEntry = {
  target: SearchTarget
  /** What the name search matches, and what the row shows. */
  title: string
  /** Searched for the query as written: a note's text, a run's code. */
  body?: string
  preview: PreviewSource
}

export type SearchHit = {
  entry: SearchEntry
  /** The body line holding the query, when the hit came from the body. */
  snippet?: string
}

export type SearchSources = {
  threads: Threads
  /** Every note in `<root>/notes`, not only this analysis's. */
  notes: readonly RootNote[]
  runs: readonly Run[]
  /** Undefined while the list is still loading. */
  files?: readonly FileEntry[]
  contents?: SearchContents
}

export const QUERIES_DIR = 'queries'

/** The file a run's code lives in, relative to the analysis folder. */
export const runCodePath = (run: Run) => (run.code ? `${QUERIES_DIR}/${run.code}` : undefined)

/** A run's files (`queries/NNN_...`) are covered by its run entry. */
function coveredFile(path: string): boolean {
  const slash = path.indexOf('/')
  if (slash < 0 || path.indexOf('/', slash + 1) >= 0) return false
  return path.slice(0, slash) === QUERIES_DIR && parseRuns([path.slice(slash + 1)]).length > 0
}

/** Every searchable thing, in the order shown for an empty query: open threads, notes newest first, runs and files newest first, closed threads. */
export function searchEntries(sources: SearchSources): SearchEntry[] {
  const noteText = new Map(sources.contents?.notes.map(n => [n.name, n.text]))
  const runCode = new Map(sources.contents?.runs.map(r => [r.number, r.code]))
  const text = (t: string): PreviewSource => ({ type: 'text', text: t })

  const open = sources.threads.open.map((thread, index): SearchEntry => ({
    target: { kind: 'thread', closed: false, index },
    title: thread,
    preview: text(thread),
  }))
  const closed = sources.threads.closed.map(({ thread, outcome }, index): SearchEntry => {
    const title = outcome ? `${thread} → ${outcome}` : thread
    return { target: { kind: 'thread', closed: true, index }, title, preview: text(title) }
  })
  const notes = [...sources.notes].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map((note): SearchEntry => {
    const body = noteText.get(note.name)
    return {
      target: { kind: 'note', name: note.name },
      title: note.title,
      ...(body !== undefined && { body }),
      preview: text(body ?? note.title),
    }
  })
  const runs = [...sources.runs].reverse().map((run): SearchEntry => {
    const body = runCode.get(run.number)
    const path = runCodePath(run)
    return {
      target: { kind: 'run', number: run.number },
      title: `${run.label} ${run.slug}`,
      ...(body !== undefined && { body }),
      preview: path ? { type: 'path', path } : text(`Run ${run.label} has no code file.`),
    }
  })
  const files = (sources.files ?? [])
    .filter(f => !coveredFile(f.path))
    .map((f): SearchEntry => ({ target: { kind: 'file', path: f.path }, title: f.path, preview: { type: 'path', path: f.path } }))
  return [...open, ...notes, ...runs, ...files, ...closed]
}

const SNIPPET = 90

/** The line of `body` holding `query` (case-insensitive), cut to about SNIPPET characters around it. */
export function snippetOf(body: string, query: string): string | undefined {
  const at = body.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return undefined
  const start = body.lastIndexOf('\n', at) + 1
  const endAt = body.indexOf('\n', at)
  const line = body.slice(start, endAt < 0 ? body.length : endAt)
  const col = at - start
  if (line.length <= SNIPPET) return line.trim()
  const from = Math.max(0, Math.min(col - SNIPPET / 3, line.length - SNIPPET))
  return `${from > 0 ? '…' : ''}${line.slice(from, from + SNIPPET).trim()}${from + SNIPPET < line.length ? '…' : ''}`
}

/**
 * Name hits first (fuzzy, best first), then body hits: entries whose body holds the query as typed.
 * An empty query gives the entries in their own order. At most `limit` hits.
 */
export function search(entries: readonly SearchEntry[], query: string, limit = 100): SearchHit[] {
  const wanted = query.trim()
  if (wanted === '') return entries.slice(0, limit).map(entry => ({ entry }))
  const byName = fuzzyRank(entries, wanted, e => e.title)
  const named = new Set(byName)
  const byBody = wanted.length < 2 ? [] : entries.filter(e => !named.has(e) && e.body !== undefined && snippetOf(e.body, wanted) !== undefined)
  return [
    ...byName.map(entry => ({ entry })),
    ...byBody.map(entry => ({ entry, snippet: snippetOf(entry.body ?? '', wanted) ?? '' })),
  ].slice(0, limit)
}

/** Equal targets: the same thread, note, file or run. */
export function sameTarget(a: SearchTarget, b: SearchTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Universal search: one list of everything in an analysis (threads, facts, note files, runs, files),
// matched by name with fuzzyRank and by body (note text, run code) as written.
import type { Fact } from './facts.ts'
import type { FileEntry } from './files.ts'
import { fuzzyRank } from './fuzzy.ts'
import { parseNoteFileName } from './noteFiles.ts'
import type { NoteFile } from './noteFiles.ts'
import { parseRuns } from './runs.ts'
import type { Run } from './runs.ts'
import type { Threads } from './threads.ts'

/** Where a hit lives, so the app can show it in its own tab. `index` is the position in threads.open, threads.closed or the facts. */
export type SearchTarget =
  | { kind: 'thread'; closed: boolean; index: number }
  | { kind: 'fact'; index: number }
  | { kind: 'note'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'run'; number: number }

/** What a preview shows: a file in the analysis folder (relative path), or text the app already holds. */
export type PreviewSource = { type: 'path'; path: string } | { type: 'text'; text: string }

/** The text of note files and run code, read by main for body search. */
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
  facts: readonly Fact[]
  threads: Threads
  noteFiles: readonly NoteFile[]
  runs: readonly Run[]
  /** Undefined while the list is still loading. */
  files?: readonly FileEntry[]
  contents?: SearchContents
}

const pad = (n: number) => String(n).padStart(3, '0')
export const NOTES_DIR = 'notes'
export const QUERIES_DIR = 'queries'

/** The file a run's code lives in, relative to the analysis folder. */
export const runCodePath = (run: Run) => (run.code ? `${QUERIES_DIR}/${run.code}` : undefined)

/** The preview of a fact: its note file, else the code of the run it cites, else its own text. */
export function factPreview(fact: Fact, runs: readonly Run[]): PreviewSource {
  if (fact.file) return { type: 'path', path: fact.file.path }
  const run = fact.query === undefined ? undefined : runs.find(r => r.number === fact.query)
  const path = run && runCodePath(run)
  return path ? { type: 'path', path } : { type: 'text', text: fact.text }
}

/** A file that a note or run entry already stands for: `notes/NNN-slug.md` and every `queries/NNN_...` run file. */
function coveredFile(path: string): boolean {
  const slash = path.indexOf('/')
  if (slash < 0 || path.indexOf('/', slash + 1) >= 0) return false
  const [dir, name] = [path.slice(0, slash), path.slice(slash + 1)]
  if (dir === NOTES_DIR) return parseNoteFileName(name) !== undefined
  return dir === QUERIES_DIR && parseRuns([name]).length > 0
}

/** Every searchable thing, in the order shown for an empty query: open threads, facts, notes, runs and files newest first, closed threads. */
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
  const facts = sources.facts.map((fact): SearchEntry => ({
    target: { kind: 'fact', index: fact.index },
    title: fact.text,
    preview: factPreview(fact, sources.runs),
  }))
  const notes = sources.noteFiles.map((note): SearchEntry => {
    const body = noteText.get(note.name)
    return {
      target: { kind: 'note', name: note.name },
      title: `${note.title} ${pad(note.number)}`,
      ...(body !== undefined && { body }),
      preview: { type: 'path', path: `${NOTES_DIR}/${note.name}` },
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
  return [...open, ...facts, ...notes, ...runs, ...files, ...closed]
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

/** Equal targets: the same thread, fact, note, file or run. */
export function sameTarget(a: SearchTarget, b: SearchTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

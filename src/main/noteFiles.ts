// The root notes in `<root>/notes` and the `notes:` lists of an analysis, read for the state and for universal search.
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join } from 'node:path'

import { ANALYSIS_FILE } from '../core/analyses.ts'
import { byCodeUnit } from '../core/nameOrder.ts'
import { NOTES_DIR, parseNoteFileName, parseNoteLists, parseRootNote } from '../core/rootNotes.ts'
import type { NoteLists, RootNote } from '../core/rootNotes.ts'
import { parseRuns } from '../core/runs.ts'
import type { SearchContents } from '../core/search.ts'
import { statSignature } from '../core/watch.ts'
import { readHead, rootOf } from './fsAccess.ts'
import { QUERIES, readQueryNames } from './runFiles.ts'

const MAX_NOTE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_BYTES = 256 * 1024

export const notesDir = (root: string) => join(root, NOTES_DIR)

/**
 * The one reader of a note file, for every route (read, list, signature, search): a regular file only. A note that is
 * a link may point anywhere on the Mac, so it is never opened (audit UI-6). Undefined when it is not a plain file.
 */
export async function readPlainNote(path: string, max: number): Promise<{ text: string; cut: boolean; info: Stats } | undefined> {
  const info = await lstat(path)
  if (!info.isFile()) return undefined
  // O_NOFOLLOW closes the gap between the lstat and the open: a file swapped for a link in between is refused.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(Math.min(info.size, max))
    await file.read(buffer, 0, buffer.length, 0)
    return { text: buffer.toString('utf8'), cut: info.size > max, info }
  } finally {
    await file.close()
  }
}

/** The note files in `<root>/notes`, sorted by name (so by ID). A link is not a note file. */
export async function noteNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(notesDir(root), { withFileTypes: true })
    return entries.filter(entry => entry.isFile() && parseNoteFileName(entry.name)).map(entry => entry.name).toSorted(byCodeUnit)
  } catch {
    return []
  }
}

// A parsed note is kept by path until its mtime or size changes.
const parsed = new Map<string, { signature: string; note: RootNote }>()

/** Every root note, parsed. A file that vanishes or cannot be read is left out. */
export async function readRootNotes(root: string): Promise<RootNote[]> {
  const found = await Promise.all(
    (await noteNames(root)).map(async name => {
      const path = join(notesDir(root), name)
      try {
        const info = await lstat(path)
        const signature = statSignature(info)
        const cached = parsed.get(path)
        if (cached?.signature === signature) return cached.note
        const read = await readPlainNote(path, MAX_NOTE_BYTES)
        if (!read) throw new Error('not a plain file')
        const note = parseRootNote(name, read.text, read.info)
        parsed.set(path, { signature, note })
        return note
      } catch {
        parsed.delete(path)
        return undefined
      }
    }),
  )
  return found.filter((note): note is RootNote => note !== undefined)
}

/** A change signature of `notes/` (names, sizes, mtimes) for the poll: editing a file in place does not touch the folder. */
export async function notesSignature(root: string): Promise<string> {
  const parts = await Promise.all(
    (await noteNames(root)).map(async name => `${name}:${statSignature(await lstat(join(notesDir(root), name)).catch(() => undefined))}`),
  )
  return parts.join('|')
}

/** The `notes:` lists of the analysis; empty when analysis.yaml has none or cannot be read. */
export async function readNoteLists(analysisPath: string): Promise<NoteLists> {
  return parseNoteLists(await readFile(join(analysisPath, ANALYSIS_FILE), 'utf8').catch(() => ''))
}

// Run code never changes, so it is read once per path; notes are few and are read each time.
const runCodeCache = new Map<string, string>()

/** A run's code, cut at MAX_SEARCH_BYTES; undefined when the run has none or it cannot be read. */
async function searchableCode(folder: string, run: { code?: string }): Promise<string | undefined> {
  if (!run.code) return undefined
  const path = join(folder, QUERIES, run.code)
  const kept = runCodeCache.get(path)
  if (kept !== undefined) return kept
  const head = await readHead(path, MAX_SEARCH_BYTES).catch(() => undefined)
  if (!head) return undefined
  // A file still being written may end mid-line: keep only finished ones.
  if (head.text.endsWith('\n') || head.cut) runCodeCache.set(path, head.text)
  return head.text
}

/** The text of every root note and every run's code, each cut at MAX_SEARCH_BYTES, for universal search. */
export async function readSearchContents(folder: string): Promise<SearchContents> {
  const root = rootOf(folder)
  const [names, runs] = await Promise.all([noteNames(root), readQueryNames(folder).then(parseRuns)])
  const notes = await Promise.all(
    names.map(async name => ({ name, text: await readPlainNote(join(notesDir(root), name), MAX_SEARCH_BYTES).then(r => r?.text, () => undefined) })),
  )
  const codes = await Promise.all(runs.map(async run => ({ number: run.number, code: await searchableCode(folder, run) })))
  return {
    notes: notes.filter((n): n is { name: string; text: string } => n.text !== undefined),
    runs: codes.filter((r): r is { number: number; code: string } => r.code !== undefined),
  }
}

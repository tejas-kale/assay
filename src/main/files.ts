// All file access for main. Paths here always come from main's own state (the window's analysis
// folder), never from the renderer; the one renderer-supplied path is a note file's, which goes
// through `readNoteFile`.
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { FsPort } from '../core/analyses.ts'
import { StaleEdit } from '../core/errors.ts'
import { listFacts } from '../core/facts.ts'
import { resolveInside } from '../core/safePath.ts'
import { parseCsv, parseRunStatus, parseRuns } from '../core/runs.ts'
import { parseThreads } from '../core/threads.ts'
import type { WatchPort } from '../core/watch.ts'
import type { AnalysisState, EditResult, NoteFileResult, RunView } from '../shared/ipc.ts'

export const NOTES = 'notes.md'
export const THREADS = 'threads.md'
const MAX_NOTE_FILE_BYTES = 2 * 1024 * 1024

const isMissing = (err: unknown) => err instanceof Error && 'code' in err && err.code === 'ENOENT'
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const fsPort: FsPort = {
  readdir: path => readdir(path),
  stat: async path => {
    try {
      const info = await stat(path)
      return { isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs }
    } catch {
      return undefined
    }
  },
  exists: async path => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  mkdir: async path => {
    await mkdir(path, { recursive: true })
  },
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
}

export const watchPort: WatchPort = {
  stat: async path => {
    try {
      const info = await stat(path)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      return undefined
    }
  },
  setInterval: (cb, ms) => {
    const timer = setInterval(cb, ms)
    return () => clearInterval(timer)
  },
}

/** The file's text, or '' when it does not exist yet. */
async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (isMissing(err)) return ''
    throw err
  }
}

/** Writes to a temp file in the same folder, then renames over the target. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
}

export async function loadState(analysis: { name: string; path: string }): Promise<AnalysisState> {
  const [notes, threads, queries, status] = await Promise.all([
    readText(join(analysis.path, NOTES)),
    readText(join(analysis.path, THREADS)),
    readQueryNames(analysis.path),
    readText(join(analysis.path, RUN_STATUS)).catch(() => ''),
  ])
  return {
    analysis,
    facts: listFacts(notes),
    threads: parseThreads(threads),
    runs: parseRuns(queries),
    runStatus: parseRunStatus(status),
  }
}

export const QUERIES = 'queries'
/** Written by the mod when the app started it. */
export const RUN_STATUS = '.assay/runs.json'
const MAX_DATA_ROWS = 1000
const MAX_DATA_BYTES = 4 * 1024 * 1024
const MAX_CODE_BYTES = 512 * 1024

/** The first `max` bytes of a file as text. */
async function readHead(path: string, max: number): Promise<{ text: string; cut: boolean }> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const buffer = Buffer.alloc(Math.min(size, max))
    await file.read(buffer, 0, buffer.length, 0)
    return { text: buffer.toString('utf8'), cut: size > max }
  } finally {
    await file.close()
  }
}

/** One run's code and saved result. The number is looked up in the folder listing, so no renderer path is used. */
export async function readRun(folder: string, number: number): Promise<RunView | undefined> {
  const run = parseRuns(await readQueryNames(folder)).find(r => r.number === number)
  if (!run) return undefined
  const dir = join(folder, QUERIES)
  const view: RunView = { run }
  try {
    if (run.code) view.code = (await readHead(join(dir, run.code), MAX_CODE_BYTES)).text
    if (run.data) {
      const { text, cut } = await readHead(join(dir, run.data), MAX_DATA_BYTES)
      // A cut file may end mid-row: drop the partial last line.
      const table = parseCsv(cut ? text.slice(0, text.lastIndexOf('\n') + 1) : text, MAX_DATA_ROWS)
      view.table = { ...table, truncated: table.truncated || cut }
    }
  } catch (err) {
    view.error = `Could not read: ${messageOf(err)}`
  }
  return view
}

/** File names in `queries/`, which fact labels are derived from. */
export async function readQueryNames(folder: string): Promise<string[]> {
  try {
    return await readdir(join(folder, QUERIES))
  } catch {
    return []
  }
}

// Edits to one file run one at a time, so two quick edits cannot read the same text.
const queues = new Map<string, Promise<unknown>>()

/**
 * Reads the file fresh, applies the core edit and writes it back atomically. A `StaleEdit`
 * becomes `stale`; any other thrown Error from the edit (empty input, file note) becomes `invalid`.
 */
export function editFile(folder: string, name: string, edit: (text: string) => string): Promise<EditResult> {
  const path = join(folder, name)
  const run = async (): Promise<EditResult> => {
    let next: string
    try {
      next = edit(await readText(path))
    } catch (err) {
      if (err instanceof StaleEdit) return { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' }
      return { ok: false, reason: 'invalid', message: messageOf(err) }
    }
    try {
      await writeAtomic(path, next)
    } catch (err) {
      return { ok: false, reason: 'invalid', message: `Could not save: ${messageOf(err)}` }
    }
    return { ok: true }
  }
  const previous = queues.get(path) ?? Promise.resolve()
  const result = previous.then(run, run)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  queues.set(path, tail)
  void tail.then(() => {
    if (queues.get(path) === tail) queues.delete(path)
  })
  return result
}

/** Reads a note file linked from notes.md. Refuses anything that resolves outside the analysis folder, symlinks included. */
export async function readNoteFile(folder: string, target: string): Promise<NoteFileResult> {
  const refused: NoteFileResult = { ok: false, message: 'Note file is outside the analysis folder' }
  const lexical = resolveInside(folder, target)
  if (!lexical) return refused
  try {
    const [realFolder, realFile] = await Promise.all([realpath(folder), realpath(lexical)])
    if (!resolveInside(realFolder, realFile)) return refused
    const info = await stat(realFile)
    if (!info.isFile()) return { ok: false, message: 'Not a file' }
    if (info.size > MAX_NOTE_FILE_BYTES) return { ok: false, message: 'Note file is too large to show' }
    return { ok: true, text: await readFile(realFile, 'utf8') }
  } catch (err) {
    return { ok: false, message: isMissing(err) ? 'Note file not found' : `Could not read: ${messageOf(err)}` }
  }
}

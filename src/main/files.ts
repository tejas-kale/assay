// All file access for main. Paths here always come from main's own state (the window's analysis
// folder), never from the renderer; the one renderer-supplied path is a note file's, which goes
// through `readNoteFile`.
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { FsPort } from '../core/analyses.ts'
import { StaleEdit } from '../core/errors.ts'
import { listFacts } from '../core/facts.ts'
import { resolveInside } from '../core/safePath.ts'
import { parseThreads } from '../core/threads.ts'
import type { WatchPort } from '../core/watch.ts'
import type { AnalysisState, EditResult, NoteFileResult } from '../shared/ipc.ts'

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
  const [notes, threads] = await Promise.all([
    readText(join(analysis.path, NOTES)),
    readText(join(analysis.path, THREADS)),
  ])
  return { analysis, facts: listFacts(notes), threads: parseThreads(threads) }
}

/** File names in `queries/`, which fact labels are derived from. */
export async function readQueryNames(folder: string): Promise<string[]> {
  try {
    return await readdir(join(folder, 'queries'))
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

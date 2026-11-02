// All file access for main. Paths here always come from main's own state (the window's analysis
// folder), never from the renderer; the one renderer-supplied path is a note file's, which goes
// through `readNoteFile`.
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { FsPort } from '../core/analyses.ts'
import { StaleEdit } from '../core/errors.ts'
import { listFacts } from '../core/facts.ts'
import { resolveInside } from '../core/safePath.ts'
import { newRequestId, parseReply, requestText } from '../core/requests.ts'
import { parseCsv, parseRunHeader, parseRunResult, parseRunStatus, parseRuns } from '../core/runs.ts'
import type { Reply } from '../core/requests.ts'
import type { ResultStatus, Run, RunHeader } from '../core/runs.ts'
import { nextNoteNumber, noteFileName, parseNoteFile, parseNoteFileName, slugify } from '../core/noteFiles.ts'
import type { NoteFile } from '../core/noteFiles.ts'
import { parseThreads } from '../core/threads.ts'
import { latestReview, parseTrustReview } from '../core/trust.ts'
import type { TrustReview } from '../core/trust.ts'
import { statSignature } from '../core/watch.ts'
import type { WatchPort } from '../core/watch.ts'
import type { SearchContents } from '../core/search.ts'
import type { AnalysisState, EditResult, NoteFileCreateResult, NoteFileResult, PlotResult, RequestResult, RunRequest, RunView } from '../shared/ipc.ts'

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
  readFile: path => readFile(path, 'utf8'),
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

export async function loadState(analysis: { name: string; title: string; path: string }): Promise<AnalysisState> {
  const [notes, threads, queries, status, noteFiles, trust] = await Promise.all([
    readText(join(analysis.path, NOTES)),
    readText(join(analysis.path, THREADS)),
    readQueryNames(analysis.path),
    readText(join(analysis.path, RUN_STATUS)).catch(() => ''),
    readNoteFiles(analysis.path),
    readLatestTrust(analysis.path),
  ])
  return {
    analysis,
    facts: listFacts(notes),
    threads: parseThreads(threads),
    runs: await withResults(analysis.path, await withHeaders(analysis.path, parseRuns(queries))),
    runStatus: parseRunStatus(status),
    noteFiles,
    ...(trust && { trust }),
  }
}

/** The latest review in `.assay/trust/`; a missing folder, a half-written file or a bad one is skipped. */
async function readLatestTrust(folder: string): Promise<TrustReview | undefined> {
  const dir = join(folder, TRUST_DIR)
  let names: string[]
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.json') && !n.startsWith('.'))
  } catch {
    return undefined
  }
  const reviews = await Promise.all(names.map(async n => parseTrustReview(await readText(join(dir, n)).catch(() => ''))))
  return latestReview(reviews.filter((r): r is TrustReview => r !== undefined))
}

// Runs are immutable, so a parsed header is kept by path and never read again.
const headers = new Map<string, RunHeader>()
const HEADER_BYTES = 2048

/** Fills each run's author, origin, trusted name and engine from the first 2 KB of its code file. */
async function withHeaders(folder: string, runs: Run[]): Promise<Run[]> {
  return Promise.all(
    runs.map(async run => {
      if (!run.code) return run
      const path = join(folder, QUERIES, run.code)
      let header = headers.get(path)
      if (!header) {
        try {
          const { text, cut } = await readHead(path, HEADER_BYTES)
          header = parseRunHeader(text, run.language)
          // The mod may still be writing the file: only a finished one (ends in a newline, or is longer than the head read) is kept.
          if (text.endsWith('\n') || (cut && text !== '')) headers.set(path, header)
        } catch {
          return run
        }
      }
      const { author, from, replay, trusted, engine } = header
      return {
        ...run,
        author,
        engine,
        ...(from !== undefined && { from }),
        ...(replay !== undefined && { replay }),
        ...(trusted !== undefined && { trusted }),
      }
    }),
  )
}

// A Python run's status is final once its `.json` says so; a running one is read again on every push.
// Keyed by the full file path, which includes the analysis folder, so analyses and windows never share entries.
const finished = new Map<string, ResultStatus>()

/** Fills each Python run's `status` from its result `.json` (rewritten every 0.5 s by rename while it runs). */
async function withResults(folder: string, runs: Run[]): Promise<Run[]> {
  return Promise.all(
    runs.map(async run => {
      if (!run.result) return run
      const path = join(folder, QUERIES, run.result)
      let status = finished.get(path)
      if (!status) {
        const result = parseRunResult(await readText(path).catch(() => ''))
        if (!result) return run
        status = result.status
        if (status !== 'running') finished.set(path, status)
      }
      return { ...run, status }
    }),
  )
}

/** The runs with headers and statuses, for deriving the label a note citing a run gets. */
export async function readRuns(folder: string): Promise<Run[]> {
  return withResults(folder, parseRuns(await readQueryNames(folder)))
}

export const QUERIES = 'queries'
/** Written by the mod when the app started it. */
export const RUN_STATUS = '.assay/runs.json'
/** Written by the mod when the app started a trust review: one `<name>.json` per review. */
export const TRUST_DIR = '.assay/trust'
const ASSAY = '.assay'
const REQUESTS = 'requests'
const REPLIES = 'replies'
export const REPLIES_DIR = join(ASSAY, REPLIES)
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
export async function readRun(folder: string, number: number, options: { table?: number } = {}): Promise<RunView | undefined> {
  const run = parseRuns(await readQueryNames(folder)).find(r => r.number === number)
  if (!run) return undefined
  const dir = join(folder, QUERIES)
  const view: RunView = { run }
  const readTable = async (file: string) => {
    const { text, cut } = await readHead(join(dir, file), MAX_DATA_BYTES)
    // A cut file may end mid-row: drop the partial last line.
    const table = parseCsv(cut ? text.slice(0, text.lastIndexOf('\n') + 1) : text, MAX_DATA_ROWS)
    return { ...table, truncated: table.truncated || cut }
  }
  try {
    if (run.code) view.code = (await readHead(join(dir, run.code), MAX_CODE_BYTES)).text
    if (run.data) view.table = await readTable(run.data)
    if (run.result) {
      const result = parseRunResult(await readText(join(dir, run.result)))
      if (result) {
        view.result = result
        view.run = { ...run, status: result.status }
      }
      const k = options.table ?? 1
      const file = run.tables[k - 1]
      if (file !== undefined) {
        view.tableIndex = k
        view.table = await readTable(file)
      }
    }
  } catch (err) {
    view.error = `Could not read: ${messageOf(err)}`
  }
  return view
}

const MAX_PLOT_BYTES = 20 * 1024 * 1024

/** Plot K (1-based) of a Python run as a data URL. The file is found in the listing, so only a `queries/` name can be read. */
export async function readPlot(folder: string, number: number, k: number): Promise<PlotResult> {
  const run = parseRuns(await readQueryNames(folder)).find(r => r.number === number)
  const file = run?.plots[k - 1]
  if (file === undefined) return { ok: false, message: 'No such plot' }
  try {
    const path = join(folder, QUERIES, file)
    if ((await stat(path)).size > MAX_PLOT_BYTES) return { ok: false, message: 'The plot is too large to show' }
    const mime = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
    return { ok: true, dataUrl: `data:${mime};base64,${(await readFile(path)).toString('base64')}` }
  } catch (err) {
    return { ok: false, message: isMissing(err) ? 'The plot file is not there yet' : `Could not read: ${messageOf(err)}` }
  }
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

/** Writes a request for the mod to pick up. The temp name starts with `.`, which the mod ignores. */
export async function writeRequest(folder: string, request: RunRequest): Promise<RequestResult> {
  const id = newRequestId(Date.now(), Math.random)
  try {
    const assay = join(folder, ASSAY)
    const dir = join(assay, REQUESTS)
    await mkdir(dir, { recursive: true })
    // Written once, never over the user's own file.
    await writeFile(join(assay, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' }).catch(() => undefined)
    const path = join(dir, `${id}.json`)
    const temp = join(dir, `.${id}.json.tmp`)
    await writeFile(temp, requestText(id, request), 'utf8')
    await rename(temp, path)
    return { ok: true, id }
  } catch (err) {
    return { ok: false, message: `Could not send: ${messageOf(err)}` }
  }
}

const JUNK_REPLY_MS = 60_000

/** Reads and deletes every reply file the mod has written. `waiting`: one is still half written, so read again soon. */
export async function takeReplies(folder: string): Promise<{ replies: Reply[]; waiting: boolean }> {
  const dir = join(folder, ASSAY, REPLIES)
  let names: string[]
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.json') && !n.startsWith('.')).sort()
  } catch {
    return { replies: [], waiting: false }
  }
  const replies: Reply[] = []
  let waiting = false
  for (const name of names) {
    const path = join(dir, name)
    try {
      const reply = parseReply(await readFile(path, 'utf8'))
      if (reply) {
        await unlink(path)
        replies.push(reply)
      } else if (Date.now() - (await stat(path)).mtimeMs > JUNK_REPLY_MS) {
        // The mod writes replies in place, so an unreadable one may be half written: wait, then give up.
        await unlink(path)
      } else waiting = true
    } catch {
      // Gone already, or half written: the next poll tries again.
    }
  }
  return { replies, waiting }
}

export const NOTE_FILES = 'notes'

/** File names in `notes/` that are note files, in number order. */
async function noteFileNames(folder: string): Promise<string[]> {
  try {
    return (await readdir(join(folder, NOTE_FILES)))
      .filter(name => parseNoteFileName(name))
      .sort((a, b) => (parseNoteFileName(a)?.number ?? 0) - (parseNoteFileName(b)?.number ?? 0) || a.localeCompare(b))
  } catch {
    return []
  }
}

// A parsed note file is kept by path until its mtime or size changes.
const parsedNotes = new Map<string, { signature: string; note: NoteFile }>()

/** Every note file in `notes/`, parsed, in number order. A file that vanishes or cannot be read is left out. */
export async function readNoteFiles(folder: string): Promise<NoteFile[]> {
  const found = await Promise.all(
    (await noteFileNames(folder)).map(async name => {
      const path = join(folder, NOTE_FILES, name)
      try {
        const info = await stat(path)
        const signature = statSignature(info)
        const cached = parsedNotes.get(path)
        if (cached?.signature === signature) return cached.note
        const note = parseNoteFile(name, (await readHead(path, MAX_NOTE_FILE_BYTES)).text, info)
        parsedNotes.set(path, { signature, note })
        return note
      } catch {
        parsedNotes.delete(path)
        return undefined
      }
    }),
  )
  return found.filter((n): n is NoteFile => n !== undefined)
}

/** A change signature of `notes/` (names, sizes, mtimes), for the poll: editing a file in place does not touch the folder. */
export async function noteFilesSignature(folder: string): Promise<string> {
  const parts = await Promise.all(
    (await noteFileNames(folder)).map(async name => {
      const info = await stat(join(folder, NOTE_FILES, name)).catch(() => undefined)
      return `${name}:${statSignature(info)}`
    }),
  )
  return parts.join('|')
}

const invalidEdit = (message: string): EditResult => ({ ok: false, reason: 'invalid', message })
const noteFilePath = (name: string) => (parseNoteFileName(name) ? `${NOTE_FILES}/${name}` : undefined)

/** Reads one note file by its name in `notes/`. */
export async function readNoteFileByName(folder: string, name: string): Promise<NoteFileResult> {
  const path = noteFilePath(name)
  return path ? readNoteFile(folder, path) : { ok: false, message: 'Not a note file' }
}

/** Creates `notes/NNN-<slug>.md` with a title line. The number and slug are derived; the file is never overwritten. */
export async function createNoteFile(folder: string, title: string): Promise<NoteFileCreateResult> {
  const clean = title.replace(/\s+/g, ' ').trim()
  if (clean === '') return { ok: false, message: 'A note needs a title' }
  const dir = join(folder, NOTE_FILES)
  try {
    await mkdir(dir, { recursive: true })
    const base = slugify(clean)
    for (let attempt = 0; attempt < 20; attempt++) {
      const names = await noteFileNames(folder)
      const slugs = new Set(names.map(n => parseNoteFileName(n)?.slug))
      let slug = base
      for (let k = 2; slugs.has(slug); k++) slug = `${base}-${k}`
      const name = noteFileName(nextNoteNumber(names), slug)
      try {
        await writeFile(join(dir, name), `# ${clean}\n\n`, { encoding: 'utf8', flag: 'wx' })
        return { ok: true, name }
      } catch (err) {
        // Another writer took the number: look again.
        if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err
      }
    }
    return { ok: false, message: 'Could not find a free note number' }
  } catch (err) {
    return { ok: false, message: `Could not create: ${messageOf(err)}` }
  }
}

/** Saves a note file's text, if the file still holds `expectedText`. */
export async function saveNoteFile(folder: string, name: string, expectedText: string, text: string): Promise<EditResult> {
  const path = noteFilePath(name)
  if (!path || !resolveInside(folder, path)) return invalidEdit('Not a note file')
  if (text.length > MAX_NOTE_FILE_BYTES) return invalidEdit('The note is too large to save')
  return editFile(folder, path, current => {
    if (current !== expectedText) throw new StaleEdit()
    return text
  })
}

/** Deletes a note file, if it still holds `expectedText`. */
export async function deleteNoteFile(folder: string, name: string, expectedText: string): Promise<EditResult> {
  const path = noteFilePath(name)
  const full = path && resolveInside(folder, path)
  if (!full) return invalidEdit('Not a note file')
  try {
    if ((await readFile(full, 'utf8')) !== expectedText) return { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' }
    await unlink(full)
    return { ok: true }
  } catch (err) {
    if (isMissing(err)) return { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' }
    return invalidEdit(`Could not delete: ${messageOf(err)}`)
  }
}

const MAX_SEARCH_BYTES = 256 * 1024
// Run code never changes, so it is read once per path; note files are few and are read each time.
const runCodeCache = new Map<string, string>()

/** The text of every note file and every run's code, each cut at MAX_SEARCH_BYTES, for universal search. */
export async function readSearchContents(folder: string): Promise<SearchContents> {
  const [noteNames, runs] = await Promise.all([noteFileNames(folder), readQueryNames(folder).then(parseRuns)])
  const notes = await Promise.all(
    noteNames.map(async name => ({ name, text: await readHead(join(folder, NOTE_FILES, name), MAX_SEARCH_BYTES).then(r => r.text, () => undefined) })),
  )
  const codes = await Promise.all(
    runs.map(async run => {
      if (!run.code) return undefined
      const path = join(folder, QUERIES, run.code)
      let code = runCodeCache.get(path)
      if (code === undefined) {
        const head = await readHead(path, MAX_SEARCH_BYTES).catch(() => undefined)
        if (!head) return undefined
        code = head.text
        // A file still being written may end mid-line: keep only finished ones.
        if (code.endsWith('\n') || head.cut) runCodeCache.set(path, code)
      }
      return { number: run.number, code }
    }),
  )
  return {
    notes: notes.filter((n): n is { name: string; text: string } => n.text !== undefined),
    runs: codes.filter((r): r is { number: number; code: string } => r !== undefined),
  }
}

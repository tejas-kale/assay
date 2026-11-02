// Root notes for main: `<root>/notes/<ID>-<slug>.md` and the `notes:` lists of the open analysis's analysis.yaml.
// The root is two folders above the analysis (`<root>/analyses/<slug>`). Names from the renderer are checked
// against the note file pattern, so only a file directly in `notes/` can be read or written.
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ANALYSIS_FILE } from '../core/analyses.ts'
import type { AnalysisRef } from '../core/analyses.ts'
import { citationLabels } from '../core/citationLabels.ts'
import type { CitationLabel } from '../core/citationLabels.ts'
import { StaleEdit } from '../core/errors.ts'
import { noteCitations, parseNoteFileName, writeRootNote } from '../core/rootNotes.ts'
import type { EditResult, NoteCreateResult, NoteReadResult, RunView } from '../shared/ipc.ts'
import { editFile, notesDir, readRun } from './files.ts'

const MAX_NOTE_BYTES = 2 * 1024 * 1024
const ANALYSES = 'analyses'
const TRUSTED = 'trusted'
const COMMIT_KEPT_MS = 20_000

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const isCode = (err: unknown, code: string) => err instanceof Error && 'code' in err && err.code === code

// The commit of a trusted calculation's file, kept briefly: git runs once per calculation, not once per citation.
const commits = new Map<string, { at: number; commit: Promise<string | undefined> }>()

const git = (folder: string, args: string[]) =>
  new Promise<string | undefined>(resolve => {
    execFile('git', ['-C', folder, ...args], { timeout: 20_000 }, (err, stdout) => resolve(err ? undefined : stdout.trim()))
  })

/**
 * The commit (12 hex digits, as a trusted run's header records it) that last changed trusted calculation `name`'s
 * file in `<root>/trusted`. Undefined when the file is not there, git fails or the name is a definition; the
 * citation is then not called stale.
 */
export function currentCommit(root: string, name: string): Promise<string | undefined> {
  const key = `${root}\0${name}`
  const kept = commits.get(key)
  if (kept && Date.now() - kept.at < COMMIT_KEPT_MS) return kept.commit
  const commit = (async () => {
    const folder = join(root, TRUSTED)
    const file = (await readdir(folder).catch(() => [])).find(each => /\.(sql|py)$/.test(each) && each.replace(/\.(sql|py)$/, '') === name)
    if (!file) return undefined
    const sha = await git(folder, ['log', '-1', '--format=%H', '--', file])
    return sha ? sha.slice(0, 12) : undefined
  })()
  commits.set(key, { at: Date.now(), commit })
  return commit
}

const labelDeps = (root: string) => ({
  fs: { readdir: (path: string) => readdir(path), readFile: (path: string) => readFile(path, 'utf8') },
  root,
  currentCommit: (name: string) => currentCommit(root, name),
})

/** A note's text with the label of each citation it holds, derived now from the cited runs. */
export async function readRootNote(root: string, name: string): Promise<NoteReadResult> {
  if (!parseNoteFileName(name)) return { ok: false, message: 'Not a note file' }
  try {
    const path = join(notesDir(root), name)
    if ((await stat(path)).size > MAX_NOTE_BYTES) return { ok: false, message: 'The note is too large to show' }
    const text = await readFile(path, 'utf8')
    const cited = noteCitations(text)
    const labels: Record<string, CitationLabel> = Object.fromEntries(await citationLabels(labelDeps(root), cited))
    return { ok: true, text, labels }
  } catch (err) {
    return { ok: false, message: isCode(err, 'ENOENT') ? 'Note not found' : `Could not read: ${messageOf(err)}` }
  }
}

/**
 * Writes a new note for the analysis: its ID is the time now (a second later while taken), bare citations are
 * qualified with the analysis's slug, and the ID goes into `notes.written`. The file is never overwritten.
 */
export async function addRootNote(root: string, analysis: AnalysisRef, title: string, body: string, now = new Date()): Promise<NoteCreateResult> {
  try {
    let failure: string | undefined
    const written = await writeRootNote(
      {
        readdir: path => readdir(path),
        mkdir: async path => void (await mkdir(path, { recursive: true })),
        createFile: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx' }),
        editYaml: async change => {
          const listed = await editFile(analysis.path, ANALYSIS_FILE, change)
          if (!listed.ok) throw new Error(listed.message)
        },
      },
      { dir: notesDir(root), slug: analysis.name, title, body, now, maxLength: MAX_NOTE_BYTES },
    )
    if (!written.ok) return { ok: false, message: { title: 'A note needs a title', size: 'The note is too large to save', id: 'Could not find a free note ID' }[written.reason] }
    if (written.listed !== true) failure = `Wrote notes/${written.file}, but could not list it in analysis.yaml: ${written.listed}`
    return failure ? { ok: false, message: failure } : { ok: true, name: written.file }
  } catch (err) {
    return { ok: false, message: `Could not create: ${messageOf(err)}` }
  }
}

/** Saves a note's text, if the file still holds `expectedText`. The title line and the file name are the user's to keep consistent. */
export async function saveRootNote(root: string, name: string, expectedText: string, text: string): Promise<EditResult> {
  if (!parseNoteFileName(name)) return { ok: false, reason: 'invalid', message: 'Not a note file' }
  if (text.length > MAX_NOTE_BYTES) return { ok: false, reason: 'invalid', message: 'The note is too large to save' }
  return editFile(notesDir(root), name, current => {
    if (current !== expectedText) throw new StaleEdit()
    return text
  })
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/

/** One run of any analysis under the root, for a citation's preview. The slug is checked, so only `<root>/analyses/<slug>` is read. */
export async function readCitedRun(root: string, analysis: string, number: number): Promise<RunView | undefined> {
  if (!SLUG.test(analysis)) return undefined
  return readRun(join(root, ANALYSES, analysis), number)
}

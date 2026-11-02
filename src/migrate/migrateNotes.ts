// The one-off migration to root notes (slice 7): each analysis's `notes.md` facts and `notes/NNN-<slug>.md` files
// become `<root>/notes/<ID>-<slug>.md`, listed under `notes.written` in analysis.yaml; then the old files go.
// A pure planner over an fs port, then `applyPlan`. Dry run unless applied. It never overwrites, never touches git,
// and a rerun finds nothing to do. The old formats are parsed here: the app no longer reads them.
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'

import { ANALYSIS_FILE, listAnalyses, type FsPort } from '../core/analyses.ts'
import { addWritten, freeId, idTime, noteBody, noteFileName, noteIds, noteLines, noteText, noteTitle, NOTES_DIR, parseNoteLists } from '../core/rootNotes.ts'

const OLD_MARKER = '.analysis'
const OLD_PARENTS = ['analyses', 'investigations', 'explorations']
const NOTES_MD = 'notes.md'

export type PlannedNote = {
  id: string
  /** The file name inside `<root>/notes/`. */
  file: string
  text: string
  /** Where it came from, for the report: `notes/003-foo.md` or `notes.md line 2`. */
  from: string
  /** A note file's own mtime, kept on the new file. */
  mtimeMs?: number
}
export type PlannedAnalysis = {
  slug: string
  path: string
  /** analysis.yaml's new text. */
  yaml: string
  notes: PlannedNote[]
  /** Paths (relative to the analysis) removed after the notes are written. */
  remove: string[]
  /** Old note-file names that stay (not `NNN-<slug>.md`), so `notes/` stays. */
  kept: string[]
}
export type Plan = { analyses: PlannedAnalysis[]; unresolved: string[] }

/** The slice 6 migration has not run: these folders still carry the old marker. */
export class NotMigratedError extends Error {}

const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).join('/')

export const nodeFsPort: FsPort = {
  readdir: path => readdir(path),
  stat: path => stat(path).then(info => ({ isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs }), () => undefined),
  exists: path => stat(path).then(() => true, () => false),
  mkdir: async path => void (await mkdir(path, { recursive: true })),
  readFile: path => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text),
}

// ---- old formats ----

const FILE_NAME = /^(\d{3,})-([a-z0-9][a-z0-9-]*)\.md$/
const NOTE_TAG = /^(.*?)\s*\[(?:(trusted|queried|computed|unverified)(?: q (\d+))?|q (\d+))\]$/
const FILE_NOTE = /^\[(.*)\]\(<(.+)>\)$/
const ORG_TITLE = /^#\+title:\s*/i

/** An org-mode `#+title:` prefix is not part of the title; text that is only the prefix stays whole. */
const stripOrgTitle = (text: string) => text.replace(ORG_TITLE, '').trim() || text

/** A `notes.md` line: its text without the label, and the run it cited. A link line keeps itself as the body. */
export function parseFactLine(line: string): { title: string; body: (slug: string) => string } {
  const link = FILE_NOTE.exec(line)
  if (link) return { title: stripOrgTitle(link[1] ?? ''), body: () => line }
  const match = NOTE_TAG.exec(line)
  let text = line
  let query: number | undefined
  if (match) {
    const [, rest = '', label, labelled, bare] = match
    // `[trusted]` and `[queried]` without a query are not tags the mod wrote: the line stays whole.
    if (!(label && label !== 'unverified' && labelled === undefined)) {
      text = rest
      const n = labelled ?? bare
      if (n !== undefined) query = Number(n)
    }
  }
  if (text.trim() === '') text = line
  const body = (slug: string) => (query === undefined ? text : `${text} [${slug} q ${query}]`)
  return { title: stripOrgTitle(text), body }
}

/** `fn` applied to every line of `text` outside fenced code. */
const outsideFences = (text: string, fn: (line: string) => string) =>
  noteLines(text)
    .map(({ line, eol, fenced }) => (fenced ? line : fn(line)) + eol)
    .join('')

type OldFile = { name: string; stem: string; slug: string; number: number; title: string; body: string; mtimeMs: number }

/** The body with `[[target]]` links resolved to `[[ID]]` and `[q N]` qualified; targets it cannot resolve are returned. */
export function rewriteBody(body: string, analysis: string, idOf: (target: string) => string | undefined): { text: string; unresolved: string[] } {
  const unresolved: string[] = []
  const text = outsideFences(body, line =>
    line
      .replace(/\[\[([^\]\n]+)\]\]/g, (whole, target: string) => {
        const id = idOf(target.trim())
        if (id === undefined) {
          if (!unresolved.includes(target.trim())) unresolved.push(target.trim())
          return whole
        }
        return `[[${id}]]`
      })
      .replace(/\[q (\d+)\]/g, (_, n: string) => `[${analysis} q ${Number(n)}]`),
  )
  return { text, unresolved }
}

// ---- planner ----

/** What the migration does for `root`. Reads only. Throws NotMigratedError while slice 6's marker is still around. */
export async function planNotes(port: FsPort, root: string): Promise<Plan> {
  for (const parent of OLD_PARENTS) {
    for (const name of await port.readdir(join(root, parent)).catch(() => [] as string[])) {
      if (await port.exists(join(root, parent, name, OLD_MARKER))) {
        throw new NotMigratedError(`${parent}/${name} still has ${OLD_MARKER}: run \`npm run migrate:root --apply\` first.`)
      }
    }
  }

  // Notes already in the root. One whose file name is the one a note would get is that note, written by an interrupted
  // run: it keeps its ID, so a rerun plans what the first run planned. Any other note's ID is simply taken.
  const existing = new Set(await port.readdir(join(root, NOTES_DIR)).catch(() => [] as string[]))
  const existingIds = new Set(noteIds([...existing]))
  const claimed = new Set<string>()
  const claim = (date: Date, title: string) => {
    let id = freeId(date, claimed)
    while (existingIds.has(id) && !existing.has(noteFileName(id, title))) id = freeId(new Date(idTime(id).getTime() + 1000), claimed)
    claimed.add(id)
    return id
  }
  const plan: Plan = { analyses: [], unresolved: [] }
  const analyses = (await listAnalyses(port, root)).sort((a, b) => a.name.localeCompare(b.name))

  for (const analysis of analyses) {
    const factsText = await port.readFile(join(analysis.path, NOTES_MD)).catch(() => undefined)
    const dirNames = await port.readdir(join(analysis.path, NOTES_DIR)).catch(() => undefined)
    if (factsText === undefined && dirNames === undefined) continue

    const files: OldFile[] = []
    const kept: string[] = []
    for (const name of [...(dirNames ?? [])].sort()) {
      const match = FILE_NAME.exec(name)
      const path = join(analysis.path, NOTES_DIR, name)
      const info = await port.stat(path)
      if (!match || !info || info.isDirectory) {
        kept.push(name)
        continue
      }
      const text = await port.readFile(path)
      files.push({ name, stem: name.slice(0, -3), slug: match[2] ?? '', number: Number(match[1]), title: noteTitle(text) ?? match[2] ?? '', body: noteBody(text), mtimeMs: info.mtimeMs })
    }
    files.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name))
    const facts = (factsText ?? '').split('\n').filter(line => line.trim() !== '')
    if (files.length === 0 && facts.length === 0 && kept.length === 0 && factsText === undefined) continue

    const notes: PlannedNote[] = []
    const ids = new Map<OldFile, string>()
    for (const file of files) {
      const id = claim(new Date(file.mtimeMs), file.title)
      ids.set(file, id)
    }
    // `[[slug]]` and `[[NNN-slug]]` name a file of this analysis; the first file wins a repeated slug.
    const idOf = (target: string) => {
      const file = files.find(f => f.stem === target) ?? files.find(f => f.slug === target)
      return file && ids.get(file)
    }
    for (const file of files) {
      const { text, unresolved } = rewriteBody(file.body, analysis.name, idOf)
      for (const target of unresolved) plan.unresolved.push(`${analysis.name}: notes/${file.name} links [[${target}]]`)
      const id = ids.get(file) ?? ''
      notes.push({ id, file: noteFileName(id, file.title), text: noteText(file.title, text), from: `notes/${file.name}`, mtimeMs: file.mtimeMs })
    }

    if (facts.length > 0) {
      const mtime = (await port.stat(join(analysis.path, NOTES_MD)))?.mtimeMs ?? Date.now()
      facts.forEach((line, i) => {
        const { title, body } = parseFactLine(line)
        const id = claim(new Date(mtime - (facts.length - i) * 1000), title)
        notes.push({ id, file: noteFileName(id, title), text: noteText(title, body(analysis.name)), from: `${NOTES_MD} line ${i + 1}` })
      })
    }

    const yaml = await port.readFile(join(analysis.path, ANALYSIS_FILE))
    const next = notes.reduce((text, note) => addWritten(text, note.id), yaml)
    const remove = [...(factsText === undefined ? [] : [NOTES_MD]), ...(dirNames === undefined ? [] : kept.length === 0 ? [NOTES_DIR] : files.map(f => `${NOTES_DIR}/${f.name}`))]
    plan.analyses.push({ slug: analysis.name, path: analysis.path, yaml: next, notes, remove, kept })
  }
  return plan
}

/** The writes `applyPlan` makes, so a test can stop it part way. */
export type ApplyFs = {
  mkdir(path: string): Promise<void>
  /** Creates the file and never overwrites: rejects with code `EEXIST` when it is there. */
  createFile(path: string, text: string): Promise<void>
  readFile(path: string): Promise<string>
  setTime(path: string, ms: number): Promise<void>
  writeFile(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
}
export const nodeApplyFs: ApplyFs = {
  mkdir: async path => void (await mkdir(path, { recursive: true })),
  createFile: (path, text) => writeFile(path, text, { flag: 'wx' }),
  readFile: path => readFile(path, 'utf8'),
  setTime: (path, ms) => utimes(path, new Date(ms), new Date(ms)),
  writeFile: (path, text) => writeFile(path, text),
  remove: path => rm(path, { recursive: true, force: true }),
}

/**
 * Writes the plan. Per analysis: the root notes first, then analysis.yaml, and only then the old files go. A note
 * file that is already there is not written again when an interrupted run left it (same text, or its ID is already
 * listed in analysis.yaml); any other file in the way stops the migration, never overwritten.
 */
export async function applyPlan(root: string, plan: Plan, fs: ApplyFs = nodeApplyFs): Promise<void> {
  await fs.mkdir(join(root, NOTES_DIR))
  for (const analysis of plan.analyses) {
    const listed = parseNoteLists(await fs.readFile(join(analysis.path, ANALYSIS_FILE))).written
    for (const note of analysis.notes) {
      const path = join(root, NOTES_DIR, note.file)
      await fs.createFile(path, note.text).catch(async (err: unknown) => {
        if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err
        if (listed.includes(note.id) || (await fs.readFile(path)) === note.text) return
        throw new Error(`${NOTES_DIR}/${note.file} exists with other text: not overwritten.`)
      })
      if (note.mtimeMs !== undefined) await fs.setTime(path, note.mtimeMs)
    }
    await fs.writeFile(join(analysis.path, ANALYSIS_FILE), analysis.yaml)
    for (const path of analysis.remove) await fs.remove(join(analysis.path, path))
  }
}

/** The report as the command prints it: one line per note, what is removed, unresolved links. */
export function printReport(plan: Plan, apply: boolean): string {
  const lines: string[] = []
  for (const analysis of plan.analyses) {
    for (const note of analysis.notes) lines.push(`${analysis.slug}: ${note.from} -> ${NOTES_DIR}/${note.file}`)
    lines.push(`${analysis.slug}: list ${analysis.notes.length} note${analysis.notes.length === 1 ? '' : 's'} under notes.written, remove ${analysis.remove.join(', ')}`)
    if (analysis.kept.length > 0) lines.push(`${analysis.slug}: keeps notes/ (not note files: ${analysis.kept.join(', ')})`)
  }
  if (plan.analyses.length === 0) lines.push('Nothing to migrate.')
  if (plan.unresolved.length > 0) lines.push('', 'Unresolved links (left as written):', ...plan.unresolved.map(each => `  ${each}`))
  const count = plan.analyses.reduce((n, a) => n + a.notes.length, 0)
  lines.push('', apply ? `Applied: ${count} note${count === 1 ? '' : 's'} in ${plan.analyses.length} analys${plan.analyses.length === 1 ? 'is' : 'es'}. Commit the changes in the root's repository yourself.` : 'Dry run: nothing changed. Run again with --apply to do it.')
  return `${lines.join('\n')}\n`
}

// The one-off migration to root notes (slice 7): each analysis's `notes.md` facts and `notes/NNN-<slug>.md` files
// become `<root>/notes/<ID>-<slug>.md`, listed under `notes.written` in analysis.yaml; then the old files go.
// A pure planner over an fs port, then `applyPlan`. Dry run unless applied. It never overwrites, never touches git,
// and a rerun finds nothing to do. The old formats are parsed here: the app no longer reads them.
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'

import { byCodeUnit } from './codeUnitOrder.ts'
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

const trimEnd = (text: string) => {
  let end = text.length
  while (end > 0 && text[end - 1] === '/') end--
  return text.slice(0, end)
}
const trimStart = (text: string) => {
  let start = 0
  while (text[start] === '/') start++
  return text.slice(start)
}
/** Joins path parts with one `/` between them: the first keeps a leading `/`, none keeps a trailing one. */
const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? trimEnd(p) : trimEnd(trimStart(p)))).join('/')

export const nodeFsPort: FsPort = {
  readdir: path => readdir(path),
  stat: path => stat(path).then(info => ({ isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs }), () => undefined),
  exists: path => stat(path).then(() => true, () => false),
  mkdir: async path => {
    await mkdir(path, { recursive: true })
  },
  readFile: path => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text),
}

// ---- old formats ----

const FILE_NAME = /^(\d{3,})-([a-z0-9][a-z0-9-]*)\.md$/
const TAG = /^\[(?:(trusted|queried|computed|unverified)(?: q (\d+))?|q (\d+))\]$/
const FILE_NOTE = /^\[(.*)\]\(<(.+)>\)$/
const ORG_TITLE = /^#\+title:\s*/i

/** An org-mode `#+title:` prefix is not part of the title; text that is only the prefix stays whole. */
const stripOrgTitle = (text: string) => text.replace(ORG_TITLE, '').trim() || text

/**
 * A line's trailing label, `[trusted q 3]`, `[queried q 3]`, `[computed q 3]`, `[unverified q 3]`, `[q 3]` (or a bare
 * `[trusted]`, `[queried]`, `[computed]`, `[unverified]`), and the text before it without the white space in between.
 * The text may not hold a line break character other than inside that white space.
 */
function noteTag(line: string): { rest: string; label?: string; labelled?: string; bare?: string } | undefined {
  const open = line.lastIndexOf('[')
  const tag = open < 0 ? null : TAG.exec(line.slice(open))
  if (!tag) return undefined
  const rest = line.slice(0, open).trimEnd()
  if (/[\n\r\u2028\u2029]/.test(rest)) return undefined
  return { rest, label: tag[1], labelled: tag[2], bare: tag[3] }
}

/** A `notes.md` line: its text without the label, and the run it cited. A link line keeps itself as the body. */
export function parseFactLine(line: string): { title: string; body: (slug: string) => string } {
  const link = FILE_NOTE.exec(line)
  if (link) return { title: stripOrgTitle(link[1] ?? ''), body: () => line }
  const match = noteTag(line)
  let text = line
  let query: number | undefined
  if (match) {
    const { rest, label, labelled, bare } = match
    // `[trusted]` and `[queried]` without a query are not tags the mod wrote: the line stays whole.
    if (!(label && label !== 'unverified' && labelled === undefined)) {
      text = rest
      const n = labelled ?? bare
      if (n !== undefined) query = Number(n)
    }
  }
  if (text.trim() === '') text = line
  const body = (slug: string) => (query === undefined ? text : `${text} [${slug} q ${String(query)}]`)
  return { title: stripOrgTitle(text), body }
}

/** `fn` applied to every line of `text` outside fenced code. */
const outsideFences = (text: string, fn: (line: string) => string) =>
  noteLines(text)
    .map(({ line, eol, fenced }) => (fenced ? line : fn(line)) + eol)
    .join('')

type OldFile = { name: string; stem: string; slug: string; number: number; title: string; body: string; mtimeMs: number }

const stopAt = /[\]\n]/g

/**
 * `line` with every `[[target]]` (a target is one or more characters but `]` and a line break) replaced by
 * `replace(whole, target)`. A scan, not a regular expression: `[[[[[` with no end would cost a regex a pass per `[`.
 */
function replaceWikiLinks(line: string, replace: (whole: string, target: string) => string): string {
  let out = ''
  let copied = 0
  let from = line.indexOf('[[')
  while (from >= 0) {
    stopAt.lastIndex = from + 2
    const end = stopAt.exec(line)?.index ?? -1
    if (end < 0) break
    if (end > from + 2 && line.startsWith(']]', end)) {
      out += line.slice(copied, from) + replace(line.slice(from, end + 2), line.slice(from + 2, end))
      copied = end + 2
      from = line.indexOf('[[', copied)
    } else {
      // No `[[` before `end` can start a link either: they all stop at `end`, which is not `]]`.
      from = line.indexOf('[[', end)
    }
  }
  return out + line.slice(copied)
}

/** The body with `[[target]]` links resolved to `[[ID]]` and `[q N]` qualified; targets it cannot resolve are returned. */
export function rewriteBody(body: string, analysis: string, idOf: (target: string) => string | undefined): { text: string; unresolved: string[] } {
  const unresolved: string[] = []
  const text = outsideFences(body, line =>
    replaceWikiLinks(line, (whole, target) => {
      const id = idOf(target.trim())
      if (id === undefined) {
        if (!unresolved.includes(target.trim())) unresolved.push(target.trim())
        return whole
      }
      return `[[${id}]]`
    }).replace(/\[q (\d+)\]/g, (_, n: string) => `[${analysis} q ${String(Number(n))}]`),
  )
  return { text, unresolved }
}

// ---- planner ----

/** Throws NotMigratedError while slice 6's marker is still around. */
async function assertMigrated(port: FsPort, root: string): Promise<void> {
  for (const parent of OLD_PARENTS) {
    for (const name of await port.readdir(join(root, parent)).catch(() => [] as string[])) {
      if (await port.exists(join(root, parent, name, OLD_MARKER))) {
        throw new NotMigratedError(`${parent}/${name} still has ${OLD_MARKER}: run \`npm run migrate:root --apply\` first.`)
      }
    }
  }
}

type Claim = (date: Date, title: string) => string

/**
 * Hands out note IDs. Notes already in the root: one whose file name is the one a note would get is that note, written
 * by an interrupted run: it keeps its ID, so a rerun plans what the first run planned. Any other note's ID is simply taken.
 */
async function idClaimer(port: FsPort, root: string): Promise<Claim> {
  const existing = new Set(await port.readdir(join(root, NOTES_DIR)).catch(() => [] as string[]))
  const existingIds = new Set(noteIds([...existing]))
  const claimed = new Set<string>()
  return (date, title) => {
    let id = freeId(date, claimed)
    while (existingIds.has(id) && !existing.has(noteFileName(id, title))) id = freeId(new Date(idTime(id).getTime() + 1000), claimed)
    claimed.add(id)
    return id
  }
}

/** One old `notes/NNN-<slug>.md`, or undefined when the name or the entry is not a note file. */
async function readOldFile(port: FsPort, dir: string, name: string): Promise<OldFile | undefined> {
  const match = FILE_NAME.exec(name)
  const path = join(dir, name)
  const info = await port.stat(path)
  if (!match || !info || info.isDirectory) return undefined
  const text = await port.readFile(path)
  const slug = match[2] ?? ''
  return { name, stem: name.slice(0, -3), slug, number: Number(match[1]), title: noteTitle(text) ?? slug, body: noteBody(text), mtimeMs: info.mtimeMs }
}

/** The old note files of an analysis in number order, and the names that stay (not note files). */
async function readOldFiles(port: FsPort, analysisPath: string, dirNames: string[]): Promise<{ files: OldFile[]; kept: string[] }> {
  const files: OldFile[] = []
  const kept: string[] = []
  for (const name of [...dirNames].sort(byCodeUnit)) {
    const file = await readOldFile(port, join(analysisPath, NOTES_DIR), name)
    if (file) files.push(file)
    else kept.push(name)
  }
  files.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name))
  return { files, kept }
}

/** The planned notes for the old note files, with their links resolved; unresolved links are added to `unresolved`. */
function planFileNotes(files: OldFile[], analysis: string, claim: Claim, unresolved: string[]): PlannedNote[] {
  const ids = new Map<OldFile, string>()
  for (const file of files) ids.set(file, claim(new Date(file.mtimeMs), file.title))
  // `[[slug]]` and `[[NNN-slug]]` name a file of this analysis; the first file wins a repeated slug.
  const idOf = (target: string) => {
    const file = files.find(f => f.stem === target) ?? files.find(f => f.slug === target)
    return file && ids.get(file)
  }
  return files.map(file => {
    const rewritten = rewriteBody(file.body, analysis, idOf)
    for (const target of rewritten.unresolved) unresolved.push(`${analysis}: notes/${file.name} links [[${target}]]`)
    const id = ids.get(file) ?? ''
    return { id, file: noteFileName(id, file.title), text: noteText(file.title, rewritten.text), from: `notes/${file.name}`, mtimeMs: file.mtimeMs }
  })
}

/** One planned note per `notes.md` line, dated a second apart, ending at the file's own mtime. */
async function planFactNotes(port: FsPort, analysis: { name: string; path: string }, facts: string[], claim: Claim): Promise<PlannedNote[]> {
  if (facts.length === 0) return []
  const mtime = (await port.stat(join(analysis.path, NOTES_MD)))?.mtimeMs ?? Date.now()
  return facts.map((line, i) => {
    const { title, body } = parseFactLine(line)
    const id = claim(new Date(mtime - (facts.length - i) * 1000), title)
    return { id, file: noteFileName(id, title), text: noteText(title, body(analysis.name)), from: `${NOTES_MD} line ${String(i + 1)}` }
  })
}

/** What goes once the notes are written: `notes.md`, and `notes/` whole or only its note files (when others stay). */
function planRemovals(factsText: string | undefined, dirNames: string[] | undefined, kept: string[], files: OldFile[]): string[] {
  const facts = factsText === undefined ? [] : [NOTES_MD]
  if (dirNames === undefined) return facts
  return [...facts, ...(kept.length === 0 ? [NOTES_DIR] : files.map(f => `${NOTES_DIR}/${f.name}`))]
}

async function planAnalysis(port: FsPort, analysis: { name: string; path: string }, claim: Claim, unresolved: string[]): Promise<PlannedAnalysis | undefined> {
  const factsText = await port.readFile(join(analysis.path, NOTES_MD)).catch(() => undefined)
  const dirNames = await port.readdir(join(analysis.path, NOTES_DIR)).catch(() => undefined)
  if (factsText === undefined && dirNames === undefined) return undefined

  const { files, kept } = await readOldFiles(port, analysis.path, dirNames ?? [])
  const facts = (factsText ?? '').split('\n').filter(line => line.trim() !== '')
  if (files.length === 0 && facts.length === 0 && kept.length === 0 && factsText === undefined) return undefined

  const notes = [...planFileNotes(files, analysis.name, claim, unresolved), ...(await planFactNotes(port, analysis, facts, claim))]
  const yaml = await port.readFile(join(analysis.path, ANALYSIS_FILE))
  const next = notes.reduce((text, note) => addWritten(text, note.id), yaml)
  return { slug: analysis.name, path: analysis.path, yaml: next, notes, remove: planRemovals(factsText, dirNames, kept, files), kept }
}

/** What the migration does for `root`. Reads only. Throws NotMigratedError while slice 6's marker is still around. */
export async function planNotes(port: FsPort, root: string): Promise<Plan> {
  await assertMigrated(port, root)
  const claim = await idClaimer(port, root)
  const plan: Plan = { analyses: [], unresolved: [] }
  const analyses = (await listAnalyses(port, root)).sort((a, b) => a.name.localeCompare(b.name))
  for (const analysis of analyses) {
    const planned = await planAnalysis(port, analysis, claim, plan.unresolved)
    if (planned) plan.analyses.push(planned)
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
  mkdir: async path => {
    await mkdir(path, { recursive: true })
  },
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

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** The report as the command prints it: one line per note, what is removed, unresolved links. */
export function printReport(plan: Plan, apply: boolean): string {
  const lines: string[] = []
  for (const analysis of plan.analyses) {
    for (const note of analysis.notes) lines.push(`${analysis.slug}: ${note.from} -> ${NOTES_DIR}/${note.file}`)
    lines.push(`${analysis.slug}: list ${String(analysis.notes.length)} note${plural(analysis.notes.length, '', 's')} under notes.written, remove ${analysis.remove.join(', ')}`)
    if (analysis.kept.length > 0) lines.push(`${analysis.slug}: keeps notes/ (not note files: ${analysis.kept.join(', ')})`)
  }
  if (plan.analyses.length === 0) lines.push('Nothing to migrate.')
  if (plan.unresolved.length > 0) lines.push('', 'Unresolved links (left as written):', ...plan.unresolved.map(each => `  ${each}`))
  const count = plan.analyses.reduce((n, a) => n + a.notes.length, 0)
  const analyses = plan.analyses.length
  const applied = `Applied: ${String(count)} note${plural(count, '', 's')} in ${String(analyses)} ${plural(analyses, 'analysis', 'analyses')}. Commit the changes in the root's repository yourself.`
  lines.push('', apply ? applied : 'Dry run: nothing changed. Run again with --apply to do it.')
  return `${lines.join('\n')}\n`
}

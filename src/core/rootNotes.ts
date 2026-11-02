// Root notes: `<root>/notes/<ID>-<slug>.md`, one kind of note shared by every analysis. The ID is a denote-style
// local timestamp (`20261102T181500`); notes link each other as `[[ID]]` and cite runs as `[<analysis-slug> q N]`.
// Used by the server, the app and the migration.
import { StaleEdit } from './errors.ts'

export const NOTES_DIR = 'notes'

/** A note as listed: its file, ID, title, links and citations. */
export type RootNote = {
  /** The file name inside `<root>/notes/`. */
  name: string
  id: string
  slug: string
  title: string
  /** Linked IDs, in order of first appearance, outside fenced code. */
  links: string[]
  /** Citations, in order of first appearance, outside fenced code. */
  citations: Citation[]
  /** The file's mtime and size when read: the reader's stale-save guard. */
  mtimeMs: number
  size: number
}

export type Citation = { analysis: string; number: number }
export type Segment = { type: 'text'; text: string } | { type: 'link'; id: string } | ({ type: 'citation' } & Citation)
export type Block =
  | { type: 'heading'; level: number; segments: Segment[] }
  | { type: 'paragraph'; segments: Segment[] }
  /** `lang` is the fence's info word, lower-cased (`mermaid`, `py`), when it has one. */
  | { type: 'code'; text: string; lang?: string }

const ID = /^\d{8}T\d{6}$/
const FILE_NAME = /^(\d{8}T\d{6})-([a-z0-9][a-z0-9-]*)\.md$/
const INLINE = /\[\[(\d{8}T\d{6})\]\]|\[([a-z0-9][a-z0-9-]*) q (\d+)\]/g
const BARE = /\[q (\d+)\]/g
const FENCE = /^\s*(```|~~~)/

export const isNoteId = (id: string) => ID.test(id)

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug === '' ? 'note' : slug
}

/** Whether `path` is `<root>/notes` or inside it. Both are real, absolute paths; compared ignoring case (macOS). */
export function inRootNotes(path: string, root: string): boolean {
  const full = path.replace(/\/+$/, '').toLowerCase()
  const notes = `${root.replace(/\/+$/, '')}/${NOTES_DIR}`.toLowerCase()
  return full === notes || full.startsWith(`${notes}/`)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The ID of a local time: `YYYYMMDDTHHMMSS`. */
export const noteId = (date: Date) =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`

/** The local time an ID names. */
export function idTime(id: string): Date {
  const n = (from: number, to: number) => Number(id.slice(from, to))
  return new Date(n(0, 4), n(4, 6) - 1, n(6, 8), n(9, 11), n(11, 13), n(13, 15))
}

/** The ID for `date`, a second later at a time until it is not in `taken`. */
export function freeId(date: Date, taken: Iterable<string>): string {
  const used = new Set(taken)
  let at = new Date(Math.floor(date.getTime() / 1000) * 1000)
  while (used.has(noteId(at))) at = new Date(at.getTime() + 1000)
  return noteId(at)
}

export const noteFileName = (id: string, title: string) => `${id}-${slugify(title)}.md`

export function parseNoteFileName(name: string): { id: string; slug: string } | undefined {
  const match = FILE_NAME.exec(name)
  return match ? { id: match[1] ?? '', slug: match[2] ?? '' } : undefined
}

/** The IDs of the note files among `names`. */
export const noteIds = (names: readonly string[]) => names.flatMap(name => parseNoteFileName(name)?.id ?? [])

/** The file holding `id`, among `names`. */
export const fileOf = (id: string, names: readonly string[]) => names.find(name => parseNoteFileName(name)?.id === id)

/** A note's text: `# <title>`, a blank line, the body (trimmed), a final newline. */
export function noteText(title: string, body: string): string {
  const head = `# ${oneTitle(title)}`
  return body.trim() ? `${head}\n\n${body.trim()}\n` : `${head}\n`
}

export const oneTitle = (title: string) => title.replace(/\s+/g, ' ').trim()

const titleLine = (text: string) => /^# +(\S.*)$/.exec(text.split('\n', 1)[0] ?? '')

export function noteTitle(text: string): string | undefined {
  return titleLine(text)?.[1]?.trim() || undefined
}

/** The text after the `# Title` line (and the blank line that follows it); all of it when there is no title line. */
export function noteBody(text: string): string {
  if (!titleLine(text)) return text
  return text.slice(text.indexOf('\n') + 1).replace(/^\n/, '')
}

export function parseRootNote(name: string, text: string, stat: { mtimeMs: number; size: number }): RootNote {
  const parsed = parseNoteFileName(name)
  const links: string[] = []
  const citations: Citation[] = []
  for (const segment of noteSegments(text)) {
    if (segment.type === 'link' && !links.includes(segment.id)) links.push(segment.id)
    if (segment.type === 'citation' && !citations.some(c => sameCitation(c, segment))) citations.push({ analysis: segment.analysis, number: segment.number })
  }
  const slug = parsed?.slug ?? name
  return { name, id: parsed?.id ?? name, slug, title: noteTitle(text) ?? slug, links, citations, mtimeMs: stat.mtimeMs, size: stat.size }
}

const sameCitation = (a: Citation, b: Citation) => a.analysis === b.analysis && a.number === b.number

/** The lines with their endings, each marked `fenced` when it is a fence line or inside fenced code. */
function lines(text: string): { line: string; eol: string; fenced: boolean }[] {
  let fenced = false
  const all = text.split('\n')
  return all.map((line, i) => {
    const eol = i < all.length - 1 ? '\n' : ''
    if (FENCE.test(line)) {
      fenced = !fenced
      return { line, eol, fenced: true }
    }
    return { line, eol, fenced }
  })
}

/** The text split at links and citations. Fenced code blocks stay plain text. */
export function noteSegments(text: string): Segment[] {
  const out: Segment[] = []
  const push = (segment: Segment) => {
    const last = out.at(-1)
    if (segment.type === 'text' && last?.type === 'text') last.text += segment.text
    else out.push(segment)
  }
  for (const { line, eol, fenced } of lines(text)) {
    if (fenced) {
      push({ type: 'text', text: line + eol })
      continue
    }
    let from = 0
    for (const match of line.matchAll(INLINE)) {
      if (match.index > from) push({ type: 'text', text: line.slice(from, match.index) })
      if (match[1] !== undefined) push({ type: 'link', id: match[1] })
      else push({ type: 'citation', analysis: match[2] ?? '', number: Number(match[3]) })
      from = match.index + match[0].length
    }
    if (from < line.length || eol) push({ type: 'text', text: line.slice(from) + eol })
  }
  return out.filter(s => s.type !== 'text' || s.text !== '')
}

/** Every bare `[q N]` outside fenced code written as `[<slug> q N]`. */
export function qualifyCitations(text: string, slug: string): string {
  return lines(text)
    .map(({ line, eol, fenced }) => (fenced ? line : line.replace(BARE, (_, n: string) => `[${slug} q ${Number(n)}]`)) + eol)
    .join('')
}

/** The text with `old` replaced by `replacement`, once; refused when `old` is missing or not unique. */
export function replaceOnce(text: string, old: string, replacement: string): string {
  if (old === '') throw new Error('`old` is empty: give the exact text to replace.')
  const at = text.indexOf(old)
  if (at < 0) throw new StaleEdit('`old` is not in the note: it may have changed since you read it. Read the note again.')
  if (text.indexOf(old, at + 1) >= 0) throw new StaleEdit('`old` appears more than once: include more of the surrounding text.')
  return text.slice(0, at) + replacement + text.slice(at + old.length)
}

/** A note's text with its body edited by an exact replacement. The title line stays. */
export function reviseBody(text: string, old: string, replacement: string): string {
  const title = noteTitle(text)
  const body = replaceOnce(noteBody(text), old, replacement)
  return title === undefined ? body : noteText(title, body)
}

/** A note's text with a new title. The file name stays. */
export const retitle = (text: string, title: string) => noteText(title, noteBody(text))

/** The body as headings, paragraphs and fenced code, for the reader. */
export function noteBlocks(body: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', segments: noteSegments(paragraph.join('\n')) })
    paragraph = []
  }
  const all = body.replace(/\n$/, '').split('\n')
  for (let i = 0; i < all.length; i++) {
    const line = all[i] ?? ''
    if (FENCE.test(line)) {
      flush()
      const fence = FENCE.exec(line)?.[1] ?? '```'
      const lang = line.trimStart().slice(fence.length).trim().split(/\s+/)[0]?.toLowerCase()
      const code: string[] = []
      for (i++; i < all.length && !(all[i] ?? '').trimStart().startsWith(fence); i++) code.push(all[i] ?? '')
      blocks.push({ type: 'code', text: code.join('\n'), ...(lang ? { lang } : {}) })
      continue
    }
    const heading = /^(#{1,6}) +(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, segments: noteSegments(heading[2] ?? '') })
    } else if (line.trim() === '') flush()
    else paragraph.push(line)
  }
  flush()
  return blocks
}

export type NoteTarget = { type: 'link'; id: string } | ({ type: 'citation' } & Citation)

/** The links and citations of the blocks in reading order, not in code: each segment with its target. */
function blockTargets(blocks: readonly Block[]): { segment: Segment; target: NoteTarget }[] {
  const out: { segment: Segment; target: NoteTarget }[] = []
  for (const block of blocks) {
    if (block.type === 'code') continue
    for (const segment of block.segments) {
      if (segment.type === 'link') out.push({ segment, target: { type: 'link', id: segment.id } })
      else if (segment.type === 'citation') out.push({ segment, target: { type: 'citation', analysis: segment.analysis, number: segment.number } })
    }
  }
  return out
}

/** What Tab moves between in the reader: the blocks' links and citations in reading order. */
export const noteTargets = (blocks: readonly Block[]) => blockTargets(blocks).map(t => t.target)

/** Each link or citation segment's index in `noteTargets`, for the renderer. */
export const targetIndices = (blocks: readonly Block[]) => new Map(blockTargets(blocks).map((t, i) => [t.segment, i]))

// The `notes:` block of analysis.yaml:
//   notes:
//     written: [20261102T181500, 20261102T183012]
//     found: [20261001T090000]

export type NoteLists = { written: string[]; found: string[] }

const NOTES_KEY = /^notes[ \t]*:[ \t]*(#.*)?$/i
const LIST_LINE = /^[ \t]+(written|found)[ \t]*:[ \t]*\[([^\]]*)\][ \t]*(#.*)?$/i

/** Where the `notes:` block is: its first line and the line after it. */
function notesBlock(rows: readonly string[]): { from: number; to: number } | undefined {
  const from = rows.findIndex(row => NOTES_KEY.test(row.replace(/\r$/, '')))
  if (from < 0) return undefined
  let to = from + 1
  while (to < rows.length && /^[ \t]+\S/.test(rows[to] ?? '')) to++
  return { from, to }
}

export function parseNoteLists(yaml: string): NoteLists {
  const rows = yaml.split('\n')
  const lists: NoteLists = { written: [], found: [] }
  const block = notesBlock(rows)
  if (!block) return lists
  for (const row of rows.slice(block.from + 1, block.to)) {
    const match = LIST_LINE.exec(row.replace(/\r$/, ''))
    if (!match) continue
    const key = (match[1] ?? '').toLowerCase() as keyof NoteLists
    lists[key] = (match[2] ?? '')
      .split(',')
      .map(each => each.trim().replace(/^['"]|['"]$/g, ''))
      .filter(isNoteId)
  }
  return lists
}

/** The yaml with its `notes:` block set to `lists`; every other line stays, and so do the line endings. */
export function setNoteLists(yaml: string, lists: NoteLists): string {
  const eol = yaml.includes('\r\n') ? '\r\n' : '\n'
  const written = unique(lists.written)
  const found = unique(lists.found).filter(id => !written.includes(id))
  const block = ['notes:', `  written: [${written.join(', ')}]`, `  found: [${found.join(', ')}]`].map(row => row + (eol === '\r\n' ? '\r' : ''))
  const rows = yaml.split('\n')
  const at = notesBlock(rows)
  if (at) {
    rows.splice(at.from, at.to - at.from, ...block)
    return rows.join('\n')
  }
  const text = yaml === '' || yaml.endsWith('\n') ? yaml : yaml + eol
  return text + block.map(row => row.replace(/\r$/, '')).join(eol) + eol
}

const unique = (ids: readonly string[]) => ids.filter((id, i) => ids.indexOf(id) === i)

export const addWritten = (yaml: string, id: string) => {
  const lists = parseNoteLists(yaml)
  return setNoteLists(yaml, { written: [...lists.written, id], found: lists.found.filter(each => each !== id) })
}

/** Adds to `found` the IDs this analysis did not write. */
export const addFound = (yaml: string, ids: readonly string[]) => {
  const lists = parseNoteLists(yaml)
  return setNoteLists(yaml, { written: lists.written, found: [...lists.found, ...ids.filter(id => !lists.written.includes(id))] })
}

export const removeWritten = (yaml: string, id: string) => {
  const lists = parseNoteLists(yaml)
  return setNoteLists(yaml, { written: lists.written.filter(each => each !== id), found: lists.found })
}

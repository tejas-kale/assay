// Note files: `notes/NNN-<slug>.md`, prose with `[[slug]]` links and `[q 12]` citations.
export type NoteFile = {
  /** The file name inside `notes/`. */
  name: string
  number: number
  slug: string
  title: string
  /** Link targets as written, in order of first appearance, outside fenced code. */
  links: string[]
  /** Cited run numbers, in order of first appearance, outside fenced code. */
  citations: number[]
  /** The file's mtime and size when read: the reader re-reads its note only when they change. */
  mtimeMs: number
  size: number
}

export type Segment = { type: 'text'; text: string } | { type: 'link'; target: string } | { type: 'citation'; number: number }
export type Block =
  | { type: 'heading'; level: number; segments: Segment[] }
  | { type: 'paragraph'; segments: Segment[] }
  | { type: 'code'; text: string }

const FILE_NAME = /^(\d{3,})-([a-z0-9][a-z0-9-]*)\.md$/
const INLINE = /\[\[([^\]\n]+)\]\]|\[q (\d+)\]/g
const FENCE = /^\s*(```|~~~)/

export function parseNoteFileName(name: string): { number: number; slug: string } | undefined {
  const match = FILE_NAME.exec(name)
  return match ? { number: Number(match[1]), slug: match[2] ?? '' } : undefined
}

export function nextNoteNumber(names: readonly string[]): number {
  return names.reduce((max, name) => Math.max(max, parseNoteFileName(name)?.number ?? 0), 0) + 1
}

export const noteFileName = (number: number, slug: string) => `${String(number).padStart(3, '0')}-${slug}.md`

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug === '' ? 'note' : slug
}

const titleLine = (text: string) => /^# +(\S.*)$/.exec(text.split('\n', 1)[0] ?? '')

/** The text after the `# Title` line (and the blank line that follows it); all of it when there is no title line. */
export function noteBody(text: string): string {
  if (!titleLine(text)) return text
  return text.slice(text.indexOf('\n') + 1).replace(/^\n/, '')
}

export function parseNoteFile(name: string, text: string, stat: { mtimeMs: number; size: number }): NoteFile {
  const parsed = parseNoteFileName(name)
  const links: string[] = []
  const citations: number[] = []
  for (const segment of noteSegments(text)) {
    if (segment.type === 'link' && !links.includes(segment.target)) links.push(segment.target)
    if (segment.type === 'citation' && !citations.includes(segment.number)) citations.push(segment.number)
  }
  const slug = parsed?.slug ?? name
  return { name, number: parsed?.number ?? 0, slug, title: titleLine(text)?.[1]?.trim() || slug, links, citations, mtimeMs: stat.mtimeMs, size: stat.size }
}

/** The text split at links and citations. Fenced code blocks stay plain text. */
export function noteSegments(text: string): Segment[] {
  const out: Segment[] = []
  const push = (segment: Segment) => {
    const last = out.at(-1)
    if (segment.type === 'text' && last?.type === 'text') last.text += segment.text
    else out.push(segment)
  }
  let fenced = false
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const eol = i < lines.length - 1 ? '\n' : ''
    if (FENCE.test(line)) {
      fenced = !fenced
      push({ type: 'text', text: line + eol })
      return
    }
    if (fenced) {
      push({ type: 'text', text: line + eol })
      return
    }
    let from = 0
    for (const match of line.matchAll(INLINE)) {
      if (match.index > from) push({ type: 'text', text: line.slice(from, match.index) })
      if (match[1] !== undefined) push({ type: 'link', target: match[1].trim() })
      else push({ type: 'citation', number: Number(match[2]) })
      from = match.index + match[0].length
    }
    if (from < line.length || eol) push({ type: 'text', text: line.slice(from) + eol })
  })
  return out.filter(s => s.type !== 'text' || s.text !== '')
}

/** The body as headings, paragraphs and fenced code, for the reader. */
export function noteBlocks(body: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', segments: noteSegments(paragraph.join('\n')) })
    paragraph = []
  }
  const lines = body.replace(/\n$/, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) {
      flush()
      const fence = FENCE.exec(line)?.[1] ?? '```'
      const code: string[] = []
      for (i++; i < lines.length && !(lines[i] ?? '').trimStart().startsWith(fence); i++) code.push(lines[i] ?? '')
      blocks.push({ type: 'code', text: code.join('\n') })
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

const stemOf = (note: NoteFile) => note.name.replace(/\.md$/, '')

export function resolveLink(target: string, notes: readonly NoteFile[]): NoteFile | undefined {
  return notes.find(n => n.slug === target) ?? notes.find(n => stemOf(n) === target)
}

/** Notes (other than `note`) with a link that resolves to it, in number order. */
export function backlinks(note: NoteFile, notes: readonly NoteFile[]): NoteFile[] {
  return notes
    .filter(n => n.name !== note.name && n.links.some(t => resolveLink(t, notes)?.name === note.name))
    .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name))
}

export type NoteTarget = { type: 'link'; target: string } | { type: 'citation'; number: number } | { type: 'backlink'; name: string }

/** The links and citations of the blocks in reading order, not in code: each segment with its target. */
function blockTargets(blocks: readonly Block[]): { segment: Segment; target: NoteTarget }[] {
  const out: { segment: Segment; target: NoteTarget }[] = []
  for (const block of blocks) {
    if (block.type === 'code') continue
    for (const segment of block.segments) {
      if (segment.type === 'link') out.push({ segment, target: { type: 'link', target: segment.target } })
      else if (segment.type === 'citation') out.push({ segment, target: { type: 'citation', number: segment.number } })
    }
  }
  return out
}

/** What Tab moves between in the reader: the blocks' links and citations in reading order, then the backlinks. */
export function noteTargets(blocks: readonly Block[], linkedFrom: readonly NoteFile[]): NoteTarget[] {
  return [...blockTargets(blocks).map(t => t.target), ...linkedFrom.map((b): NoteTarget => ({ type: 'backlink', name: b.name }))]
}

/** Each link or citation segment's index in `noteTargets`, for the renderer. Backlink `i` is at `blockTargetCount + i`. */
export function targetIndices(blocks: readonly Block[]): Map<Segment, number> {
  return new Map(blockTargets(blocks).map((t, i) => [t.segment, i]))
}

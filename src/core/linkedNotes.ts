// The title of a note file that `link_note` lists in notes.md, ported from the analysis mod's hooks/model.ts
// (noteBlocks, titleOf, baseName). The file may be Markdown or org, anywhere the user named.
import { oneLine } from './text.ts'

// Org: `#+key:` lines and `:PROPERTIES:` … `:END:` drawers. YAML front matter's fences.
const META_LINE = /^\s*(#\+\w+:.*|:[\w-]+:.*|---\s*)$/
const FENCE_OPEN = /^\s*(```|~~~|#\+begin_)/i
const FENCE_CLOSE = /^\s*(```|~~~|#\+end_)/i

export type NoteBlock = { start: number; end: number; isMeta: boolean }

export function paragraphs(lines: readonly string[]): NoteBlock[] {
  const blocks: NoteBlock[] = []
  let i = 0
  while (i < lines.length) {
    if ((lines[i] ?? '').trim() === '') {
      i++
      continue
    }
    const start = i
    if (i === 0 && /^---\s*$/.test(lines[0] ?? '')) {
      i++
      while (i < lines.length && !/^---\s*$/.test(lines[i] ?? '')) i++
      blocks.push({ start, end: Math.min(i + 1, lines.length), isMeta: true })
      i++
      continue
    }
    let isFenced = false
    while (i < lines.length && (isFenced || (lines[i] ?? '').trim() !== '')) {
      const line = lines[i] ?? ''
      if (isFenced ? FENCE_CLOSE.test(line) : FENCE_OPEN.test(line)) isFenced = !isFenced
      i++
    }
    blocks.push({ start, end: i, isMeta: lines.slice(start, i).every(line => META_LINE.test(line)) })
  }
  return blocks
}

/**
 * A note file's title: org's `#+title:`, else `title:` in front matter, else
 * the first line of its first paragraph, without heading marks.
 */
export function titleOf(text: string): string | undefined {
  const org = /^[ \t]*#\+title:[ \t]*(.*?)\s*$/im.exec(text)?.[1]
  if (org) return oneLine(org)
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text)
  const fromFront = front && /^title:\s*(["']?)(.+?)\1\s*$/m.exec(front[1] ?? '')?.[2]
  if (fromFront) return oneLine(fromFront)
  const lines = text.split('\n')
  const first = paragraphs(lines).find(block => !block.isMeta)
  const line = first ? (lines[first.start] ?? '') : ''
  return oneLine(line.replace(/^\s*(#{1,6}|\*+)\s+/, '').replace(/\s+#+\s*$/, '')) || undefined
}

/** A file's name without its folder or `.md` / `.org`: the title of a note that has none. */
export const baseName = (path: string) => path.replace(/\/+$/, '').replace(/^.*\//, '').replace(/\.(md|org)$/i, '')

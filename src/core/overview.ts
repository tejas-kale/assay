// The analysis and system overviews (docs/slice-10.md, slice 10a): the system an analysis overview names, its
// Markdown split into blocks, and the block diff against the text the user last marked read.

/** The analysis overview, in the analysis folder. */
export const OVERVIEW_FILE = 'overview.md'
/** System overviews, in the root: `systems/<system>.md`. */
export const SYSTEMS_DIR = 'systems'
/** Where "mark read" keeps each document's baseline, in the analysis folder (`.assay/` ignores itself). */
export const OVERVIEW_READ_DIR = '.assay/overview-read'
/** About one page: the tab shows the line count amber above this. */
export const OVERVIEW_LINE_CAP = 50

export type OverviewWhich = 'analysis' | 'system'

/** One document as the tab gets it: its path from the root, its text, and the text last marked read. */
export type OverviewDoc = { path: string; text: string; baseline?: string }

/**
 * What the Overview tab shows. `system` is the file the analysis overview names (`systems/<name>.md`), absent when it
 * names none; `systemDoc` is that file, absent when it does not exist.
 */
export type OverviewState = { analysis?: OverviewDoc; system?: string; systemDoc?: OverviewDoc }

const SYSTEM_LINE = /^\s*(?:[>^]\s*)?System:\s*(systems\/([a-z0-9][a-z0-9-]*)\.md)\s*$/i
const SYSTEM_LINES = 5

/** The system file (`systems/<name>.md`) the overview names on a line of its own among its first 5 lines. */
export function systemOf(text: string): string | undefined {
  for (const line of text.split('\n').slice(0, SYSTEM_LINES)) {
    const match = SYSTEM_LINE.exec(line)
    if (match?.[2]) return `${SYSTEMS_DIR}/${match[2].toLowerCase()}.md`
  }
  return undefined
}

/** Lines, not counting a final newline: what the cap is measured in. */
export function lineCount(text: string): number {
  if (text === '') return 0
  return text.replace(/\n$/, '').split('\n').length
}

const FENCE = /^\s*(```|~~~)/
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/
const HEADING = /^#{1,6}\s/
const TABLE_ROW = /^\s*\|/

/**
 * The Markdown as blocks, each its source text: a heading, a fenced code block, a table, each list item (with its
 * indented continuation lines), and each paragraph. Blank lines separate; they belong to no block.
 */
export function markdownBlocks(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let kind: 'paragraph' | 'item' | 'table' | undefined
  const flush = () => {
    if (current.length > 0) blocks.push(current.join('\n'))
    current = []
    kind = undefined
  }
  const lines = text.replace(/\n$/, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)?.[1]
    if (fence) {
      flush()
      const code = [line]
      for (i++; i < lines.length; i++) {
        code.push(lines[i] ?? '')
        if ((lines[i] ?? '').trimStart().startsWith(fence)) break
      }
      blocks.push(code.join('\n'))
      continue
    }
    if (line.trim() === '') flush()
    else if (HEADING.test(line)) {
      flush()
      blocks.push(line)
    } else if (TABLE_ROW.test(line)) {
      if (kind !== 'table') flush()
      kind = 'table'
      current.push(line)
    } else if (LIST_ITEM.test(line)) {
      flush()
      kind = 'item'
      current.push(line)
    } else {
      // An indented line continues a list item; any other line continues its paragraph, or starts one.
      if (kind === 'table' || (kind === 'item' && !/^\s/.test(line))) flush()
      kind ??= 'paragraph'
      current.push(line)
    }
  }
  flush()
  return blocks
}

export type DiffBlock = { kind: 'same' | 'added' | 'removed'; text: string }

/**
 * The document's blocks against the baseline's, by longest common subsequence. A changed block shows as the old one
 * removed, then the new one added. Without a baseline every block is added.
 */
export function overviewDiff(baseline: string | undefined, text: string): DiffBlock[] {
  const now = markdownBlocks(text)
  if (baseline === undefined) return now.map(block => ({ kind: 'added', text: block }))
  const before = markdownBlocks(baseline)
  const n = before.length
  const m = now.length
  // lcs[i][j]: the common subsequence length of before[i..] and now[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] = before[i] === now[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: DiffBlock[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === now[j]) {
      out.push({ kind: 'same', text: now[j] ?? '' })
      i++
      j++
    } else if (j < m && (i >= n || (lcs[i + 1]?.[j] ?? 0) < (lcs[i]?.[j + 1] ?? 0))) {
      out.push({ kind: 'added', text: now[j] ?? '' })
      j++
    } else {
      out.push({ kind: 'removed', text: before[i] ?? '' })
      i++
    }
  }
  // Within a run of changes, removals first: a rewritten paragraph reads old, then new.
  const ordered: DiffBlock[] = []
  let run: DiffBlock[] = []
  const flush = () => {
    ordered.push(...run.filter(b => b.kind === 'removed'), ...run.filter(b => b.kind === 'added'))
    run = []
  }
  for (const block of out) {
    if (block.kind === 'same') {
      flush()
      ordered.push(block)
    } else run.push(block)
  }
  flush()
  return ordered
}

/** Whether the diff holds any change. */
export const hasChanges = (diff: readonly DiffBlock[]) => diff.some(block => block.kind !== 'same')

/** The baseline's path in the analysis folder for a document's path from the root. */
export function baselinePath(which: OverviewWhich, system: string | undefined): string | undefined {
  if (which === 'analysis') return `${OVERVIEW_READ_DIR}/${OVERVIEW_FILE}`
  return system ? `${OVERVIEW_READ_DIR}/${system}` : undefined
}

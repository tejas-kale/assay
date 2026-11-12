// The analysis and system overviews (specs/slices/slice-10.md, slice 10a): the system an analysis overview names, its
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

type BlockKind = 'paragraph' | 'item' | 'table'

/** The blocks so far, and the lines of the one still open. */
function blockBuilder() {
  const blocks: string[] = []
  let current: string[] = []
  let kind: BlockKind | undefined
  return {
    blocks,
    kind: () => kind,
    flush() {
      if (current.length > 0) blocks.push(current.join('\n'))
      current = []
      kind = undefined
    },
    emit(block: string) {
      blocks.push(block)
    },
    add(line: string, as: BlockKind) {
      kind = as
      current.push(line)
    },
  }
}

type BlockBuilder = ReturnType<typeof blockBuilder>

/** A fenced block from its opening line at `start` to the closing line (or the end): its text, and the last line index it used. */
function fencedBlock(lines: readonly string[], start: number, fence: string): { block: string; end: number } {
  const code = [lines[start] ?? '']
  let end = start + 1
  for (; end < lines.length; end++) {
    const line = lines[end] ?? ''
    code.push(line)
    if (line.trimStart().startsWith(fence)) break
  }
  return { block: code.join('\n'), end }
}

function addLine(builder: BlockBuilder, line: string) {
  if (line.trim() === '') {
    builder.flush()
  } else if (HEADING.test(line)) {
    builder.flush()
    builder.emit(line)
  } else if (TABLE_ROW.test(line)) {
    if (builder.kind() !== 'table') builder.flush()
    builder.add(line, 'table')
  } else if (LIST_ITEM.test(line)) {
    builder.flush()
    builder.add(line, 'item')
  } else {
    // An indented line continues a list item; any other line continues its paragraph, or starts one.
    const kind = builder.kind()
    if (kind === 'table' || (kind === 'item' && !/^\s/.test(line))) builder.flush()
    builder.add(line, builder.kind() ?? 'paragraph')
  }
}

/**
 * The Markdown as blocks, each its source text: a heading, a fenced code block, a table, each list item (with its
 * indented continuation lines), and each paragraph. Blank lines separate; they belong to no block.
 */
export function markdownBlocks(text: string): string[] {
  const builder = blockBuilder()
  const lines = text.replace(/\n$/, '').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)?.[1]
    if (fence) {
      builder.flush()
      const { block, end } = fencedBlock(lines, i, fence)
      builder.emit(block)
      i = end + 1
    } else {
      addLine(builder, line)
      i++
    }
  }
  builder.flush()
  return builder.blocks
}

export type DiffBlock = { kind: 'same' | 'added' | 'removed'; text: string }

/** lcs[i][j]: the common subsequence length of before[i..] and now[j..]. */
function commonLengths(before: readonly string[], now: readonly string[]): (i: number, j: number) => number {
  const lcs: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(now.length + 1).fill(0))
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0
  for (let i = before.length - 1; i >= 0; i--) {
    const row = lcs[i] ?? []
    for (let j = now.length - 1; j >= 0; j--) {
      row[j] = before[i] === now[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  return at
}

/** The walk down the common subsequence: each block is same, added or removed. */
function walkBlocks(before: readonly string[], now: readonly string[]): DiffBlock[] {
  const common = commonLengths(before, now)
  const out: DiffBlock[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < now.length) {
    const old = before[i]
    const fresh = now[j]
    if (old !== undefined && old === fresh) {
      out.push({ kind: 'same', text: old })
      i++
      j++
    } else if (fresh !== undefined && (old === undefined || common(i + 1, j) < common(i, j + 1))) {
      out.push({ kind: 'added', text: fresh })
      j++
    } else if (old !== undefined) {
      out.push({ kind: 'removed', text: old })
      i++
    }
  }
  return out
}

/** Within a run of changes, removals first: a rewritten paragraph reads old, then new. */
function removalsFirst(diff: readonly DiffBlock[]): DiffBlock[] {
  const ordered: DiffBlock[] = []
  let run: DiffBlock[] = []
  const flush = () => {
    ordered.push(...run.filter(b => b.kind === 'removed'), ...run.filter(b => b.kind === 'added'))
    run = []
  }
  for (const block of diff) {
    if (block.kind === 'same') {
      flush()
      ordered.push(block)
    } else run.push(block)
  }
  flush()
  return ordered
}

/**
 * The document's blocks against the baseline's, by longest common subsequence. A changed block shows as the old one
 * removed, then the new one added. Without a baseline every block is added.
 */
export function overviewDiff(baseline: string | undefined, text: string): DiffBlock[] {
  const now = markdownBlocks(text)
  if (baseline === undefined) return now.map(block => ({ kind: 'added', text: block }))
  return removalsFirst(walkBlocks(markdownBlocks(baseline), now))
}

/** Whether the diff holds any change. */
export const hasChanges = (diff: readonly DiffBlock[]) => diff.some(block => block.kind !== 'same')

/** The baseline's path in the analysis folder for a document's path from the root. */
export function baselinePath(which: OverviewWhich, system: string | undefined): string | undefined {
  if (which === 'analysis') return `${OVERVIEW_READ_DIR}/${OVERVIEW_FILE}`
  return system ? `${OVERVIEW_READ_DIR}/${system}` : undefined
}

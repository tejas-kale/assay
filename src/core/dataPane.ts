// The data pane's decisions (src/renderer/components/DataPane.tsx and components/data/): what a key does in each
// tab, what a reply says, and what the header and the tab markers show. The components only carry them out.

import type { Reply, RunRequest } from './requests.ts'
import type { Engine, Run, RunStatus } from './runs.ts'
import type { Seen, TabIdIn } from './tabs.ts'

/** One line of a table or of a run's text, in pixels. */
export const LINE_PX = 22

/** `n` within 1..count; 1 when there is nothing to choose. */
export const clampTo = (n: number, count: number): number => Math.max(1, Math.min(n, count))

/** A run's number as its files write it: `007`. */
export const runNumber = (number: number): string => String(number).padStart(3, '0')

/** The engine a new query runs on: the latest SQL run's. */
export const sqlEngine = (runs: readonly Run[]): Engine => runs.findLast(r => r.language === 'sql')?.engine ?? 'databricks'

// ---------------------------------------------------------------------------
// Keys.

const DOWN = new Set(['j', 'ArrowDown'])
const UP = new Set(['k', 'ArrowUp'])
const PAGE_DOWN = new Set(['J', 'PageDown'])
const PAGE_UP = new Set(['K', 'PageUp'])

/** The keys every run tab shares: `c` the code, `p` pin, `,` and `.` the run before or after. */
export type RunKey = { kind: 'code' } | { kind: 'pin' } | { kind: 'step'; delta: 1 | -1 }

export function runKey(key: string): RunKey | undefined {
  if (key === 'c') return { kind: 'code' }
  if (key === 'p') return { kind: 'pin' }
  if (key === ',' || key === '.') return { kind: 'step', delta: key === '.' ? 1 : -1 }
  return undefined
}

export type Cell = { row: number; col: number }
/** The cursor, whether the whole row is open, the table's size and how many rows a page holds. */
export type Grid = { at: Cell; rowOpen: boolean; rows: number; cols: number; page: number }
export type GridAction = { kind: 'move'; cell: Cell } | { kind: 'open'; open: boolean } | { kind: 'copy' }

/** A cell inside the table. */
export const clampCell = (cell: Cell, rows: number, cols: number): Cell => ({
  row: Math.max(0, Math.min(cell.row, rows - 1)),
  col: Math.max(0, Math.min(cell.col, cols - 1)),
})

/**
 * The Data tab's table keys: h/j/k/l move, J/K a page, g/G first/last row, 0/$ first/last column, Enter opens the
 * row, y copies. An open row takes only j/k, and Enter or Escape to close it.
 */
export function gridKey(key: string, grid: Grid): GridAction | undefined {
  const { at, rows, cols } = grid
  const move = (row: number, col: number): GridAction => ({ kind: 'move', cell: clampCell({ row, col }, rows, cols) })
  if (DOWN.has(key)) return move(at.row + 1, at.col)
  if (UP.has(key)) return move(at.row - 1, at.col)
  if (grid.rowOpen) return key === 'Escape' || key === 'Enter' ? { kind: 'open', open: false } : undefined
  const moves: Record<string, [number, number] | undefined> = {
    l: [at.row, at.col + 1],
    ArrowRight: [at.row, at.col + 1],
    h: [at.row, at.col - 1],
    ArrowLeft: [at.row, at.col - 1],
    g: [0, at.col],
    G: [rows - 1, at.col],
    '0': [at.row, 0],
    $: [at.row, cols - 1],
  }
  if (PAGE_DOWN.has(key)) return move(at.row + grid.page, at.col)
  if (PAGE_UP.has(key)) return move(at.row - grid.page, at.col)
  const to = moves[key]
  if (to) return move(to[0], to[1])
  if (key === 'Enter') return { kind: 'open', open: true }
  return key === 'y' ? { kind: 'copy' } : undefined
}

/** How the text view scrolls on a key: by two lines or a page, or to an end. */
export function textScroll(key: string, box: { height: number; scrollHeight: number }): { by: number } | { to: number } | undefined {
  if (DOWN.has(key)) return { by: 2 * LINE_PX }
  if (UP.has(key)) return { by: -2 * LINE_PX }
  if (PAGE_DOWN.has(key)) return { by: box.height - LINE_PX }
  if (PAGE_UP.has(key)) return { by: LINE_PX - box.height }
  if (key === 'g') return { to: 0 }
  return key === 'G' ? { to: box.scrollHeight } : undefined
}

/** The Plots tab: the next plot on j, l and the arrows down and right; the one before on k, h, up and left. */
export function plotKey(key: string): 1 | -1 | undefined {
  if (DOWN.has(key) || key === 'l' || key === 'ArrowRight') return 1
  if (UP.has(key) || key === 'h' || key === 'ArrowLeft') return -1
  return undefined
}

export type HistoryAction = { kind: 'select'; index: number } | { kind: 'pin' } | { kind: 'choose' }

/** History's keys over `count` runs, newest first; `index` is the selected one. */
export function historyKey(key: string, index: number, count: number): HistoryAction | undefined {
  if (DOWN.has(key)) return { kind: 'select', index: index + 1 }
  if (UP.has(key)) return { kind: 'select', index: Math.max(0, index - 1) }
  if (key === 'g' || key === 'G') return { kind: 'select', index: key === 'g' ? 0 : count - 1 }
  if (key === 'p') return { kind: 'pin' }
  return key === 'Enter' ? { kind: 'choose' } : undefined
}

// ---------------------------------------------------------------------------
// Requests.

const DONE_TEXT: Partial<Record<RunRequest['kind'], string>> = {
  interrupt: 'Interrupted.',
  restart: 'Kernel restarted.',
  replay: 'Replay finished.',
}

/** What the pane says when a reply comes: a refused run, or how an interrupt, a restart or a replay ended. */
export function replyToast(kind: RunRequest['kind'] | undefined, reply: Reply): string | undefined {
  const done = kind && DONE_TEXT[kind]
  if ('error' in reply) return done ? reply.error : `The run was refused: ${reply.error}`
  return 'ok' in reply ? done : undefined
}

/** Whether a request sent when there were `sentAt` runs went unseen: nothing runs, no run came, no kernel starts. */
export function pickupMissed(now: { status: RunStatus; runCount: number }, sentAt: number): boolean {
  return !now.status.running && now.runCount === sentAt && now.status.kernel?.state !== 'starting'
}

// ---------------------------------------------------------------------------
// What the pane shows.

/** The tab, the current run's table and plot choice, and the Steps tab's running step, if any. */
export type NoteFacts = {
  tab: TabIdIn<'data'>
  python: boolean
  textView: boolean
  table: { k: number; count: number }
  plot: { n: number; count: number }
  steps: string | undefined
}

/** The dim note in the run header: which table or plot is shown, or the step that runs. */
export function headerNote(facts: NoteFacts): string | undefined {
  const { tab, table, plot } = facts
  if (tab === 'data') return facts.python && !facts.textView && table.count > 0 ? `table ${String(table.k)} of ${String(table.count)}` : undefined
  if (tab === 'plots') return plot.count > 0 ? `plot ${String(plot.n)} of ${String(plot.count)}` : undefined
  return tab === 'steps' ? facts.steps : undefined
}

const counted = (count: number, noun: string) => `${String(count)} ${noun}${count === 1 ? '' : 's'}`

/** History's summary of a run's files: `sql + csv + 2 steps`. */
export function runFiles(run: Run): string {
  const parts = [
    run.code && (run.language === 'python' ? 'py' : 'sql'),
    run.data && 'csv',
    run.steps !== undefined && counted(run.steps, 'step'),
    run.tables.length > 0 && counted(run.tables.length, 'table'),
    run.plots.length > 0 && counted(run.plots.length, 'plot'),
  ]
  return parts.filter(Boolean).join(' + ')
}

/**
 * What the tab markers compare between two state pushes. A SQL run's result is its csv; a Python run's is its status
 * and tables, so finishing marks Data too.
 */
export function seenOf(at: { current: Run | undefined; status: RunStatus; runCount: number; trust?: string }): Seen {
  const { current } = at
  const result = current?.result ? `${current.status ?? ''}:${String(current.tables.length)}` : undefined
  const data = current?.data ?? result
  return {
    ...(current && { number: current.number }),
    ...(current?.code !== undefined && { code: current.code }),
    ...(data !== undefined && { data }),
    plots: current?.plots ?? [],
    failed: current ? at.status.failed[current.number] !== undefined : false,
    runCount: at.runCount,
    ...(at.trust !== undefined && { trust: at.trust }),
  }
}

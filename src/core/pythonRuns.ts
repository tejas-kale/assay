// Python runs and their replies, ported from the analysis mod's hooks/model.ts: the kernel's events, the one JSON
// line `analysis_kernel.py run` prints, and the text Claude gets back. Also the reply text of a SQL run.

export const queryLabel = (n: number) => String(n).padStart(3, '0')

/** A run's slug: short kebab case, `query` when nothing is left. */
export const runSlug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '') || 'query'

const csvCell = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)

export const toCsv = (columns: readonly string[], rows: readonly (readonly string[])[]) =>
  [columns, ...rows].map(row => `${row.map(csvCell).join(',')}\n`).join('')

export const cut = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > width ? `${flat.slice(0, Math.max(0, width - 1))}…` : flat
}

/** Columns padded to their widest cell (each cut to `maxCell`), two spaces apart. */
export function formatTable(columns: readonly string[], rows: readonly (readonly string[])[], maxCell: number) {
  const lines = [columns, ...rows].map(row => row.map(cell => cut(cell, maxCell)))
  const widths = columns.map((_, c) => Math.max(...lines.map(line => line[c]?.length ?? 0)))
  return lines
    .map(line =>
      line
        .map((cell, c) => (c === line.length - 1 ? cell : cell.padEnd(widths[c] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

export type KernelEvent =
  | { event: 'ready'; kernel: string; pid: number }
  | { event: 'interrupted' }
  | { event: 'stopped' }
  | { event: 'dead'; message: string }
  | { event: 'missing'; message: string }

/** The complete event lines in `buffer` (a serve process's stdout so far), and the partial line left. Other lines are ignored. */
export function splitKernelEvents(buffer: string): { events: KernelEvent[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const events: KernelEvent[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown> | null
      const event = parsed?.event
      if (event === 'ready' && typeof parsed?.pid === 'number') {
        events.push({ event, kernel: typeof parsed.kernel === 'string' ? parsed.kernel : '', pid: parsed.pid })
      } else if (event === 'interrupted' || event === 'stopped') events.push({ event })
      else if (event === 'dead' || event === 'missing') {
        events.push({ event, message: typeof parsed?.message === 'string' ? parsed.message : `The kernel is ${event}.` })
      }
    } catch {
      // Not an event: a stray print of the runner.
    }
  }
  return { events, rest }
}

export type { KernelState } from './runs.ts'
export type PythonTable = { file: string; columns: string[]; rows: string[][]; rowCount: number; truncated: boolean }
export type PythonRun = {
  status: 'ok' | 'error' | 'interrupted'
  stdout: string
  error?: { name?: string; message?: string; traceback?: string }
  tables: PythonTable[]
  plots: string[]
  reads: number[]
  /** How long the run took, as the runner measured it. */
  durationMs?: number
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

/** The one JSON line `analysis_kernel.py run` prints, or why it is not one. */
export function parsePythonRun(stdout: string): PythonRun | { error: string } {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
  let body: Record<string, unknown> | null
  try {
    body = JSON.parse(line) as Record<string, unknown> | null
  } catch {
    return { error: line ? `The kernel runner printed: ${cut(line, 200)}` : 'The kernel runner printed nothing.' }
  }
  const status = body?.status
  if (!body || (status !== 'ok' && status !== 'error' && status !== 'interrupted')) {
    return { error: `The kernel runner gave no status: ${cut(line, 200)}` }
  }
  const tables = (Array.isArray(body.tables) ? body.tables : []).flatMap((each: unknown): PythonTable[] => {
    const table = each as Record<string, unknown> | null
    if (!table || typeof table.file !== 'string') return []
    const rows = Array.isArray(table.rows) ? table.rows.map(row => (Array.isArray(row) ? row.map(String) : [])) : []
    return [
      {
        file: table.file,
        columns: strings(table.columns),
        rows,
        rowCount: typeof table.rowCount === 'number' ? table.rowCount : rows.length,
        truncated: table.truncated === true,
      },
    ]
  })
  const plots = (Array.isArray(body.plots) ? body.plots : []).flatMap((each: unknown) => {
    const file = typeof each === 'string' ? each : (each as { file?: unknown } | null)?.file
    return typeof file === 'string' ? [file] : []
  })
  const error = body.error && typeof body.error === 'object' ? (body.error as PythonRun['error']) : undefined
  return {
    status,
    stdout: typeof body.stdout === 'string' ? body.stdout : '',
    ...(error ? { error } : {}),
    tables,
    plots,
    reads: (Array.isArray(body.reads) ? body.reads : []).filter((n): n is number => typeof n === 'number'),
    ...(typeof body.durationMs === 'number' ? { durationMs: body.durationMs } : {}),
  }
}

const TRACEBACK_LINES = 30

/**
 * Claude's reply for a finished Python run: its status and time, the tail of
 * stdout, the error's traceback (last 30 lines), each table (at most 50 rows)
 * and each plot's file.
 */
export function formatPythonRun(number: number, run: PythonRun, ms: number, queriesDir = 'queries', maxCell = 80): string {
  const lines = [`Run ${queryLabel(number)}: ${run.status} (${((run.durationMs ?? ms) / 1000).toFixed(1)} s).`]
  if (run.stdout.trim()) lines.push(run.stdout.trimEnd())
  if (run.error) {
    const traceback = (run.error.traceback ?? '').trimEnd().split('\n').slice(-TRACEBACK_LINES).join('\n')
    lines.push(traceback || [run.error.name, run.error.message].filter(Boolean).join(': '))
  }
  run.tables.forEach((table, i) => {
    const shown = table.rows.slice(0, 50)
    const rows = `${table.rowCount} ${table.rowCount === 1 ? 'row' : 'rows'}`
    const file = `${queriesDir}/${table.file}`
    lines.push(`Table ${i + 1} (${file}): ${rows}. Columns: ${table.columns.join(', ')}`)
    if (shown.length > 0) lines.push(formatTable(table.columns, shown, maxCell))
    if (table.rowCount > shown.length) lines.push(`Truncated: showing ${shown.length} of ${table.rowCount} rows. ${file} has ${table.truncated ? 'the first 100000 of them' : 'all of them'}.`)
  })
  for (const plot of run.plots) lines.push(`Plot: ${queriesDir}/${plot} (Read it to check the chart.)`)
  return lines.join('\n')
}

/** The header lines a Python run's .py starts with (Python comments, so the file runs as it is). */
export const pythonHeader = (header: { author?: 'user'; from?: number; replay?: number }) =>
  [
    ...(header.author ? [`# author: ${header.author}`] : []),
    ...(header.from ? [`# from: ${queryLabel(header.from)}`] : []),
    ...(header.replay ? [`# replay: ${queryLabel(header.replay)}`] : []),
  ].map(line => `${line}\n`).join('')

/** A Python run's .py text without its leading header lines: the code that ran. */
export const pythonBody = (text: string) => text.replace(/^(?:# (?:author|from|replay):[^\n]*\n)+/, '')

/** Where a project venv's python may be, nearest first: `.venv/bin/python` of the folder and each parent up to `/`. */
export function venvCandidates(dir: string): string[] {
  const parts = dir.split('/').filter(Boolean)
  const candidates: string[] = []
  for (let i = parts.length; i >= 0; i--) candidates.push(`${i === 0 ? '' : `/${parts.slice(0, i).join('/')}`}/.venv/bin/python`)
  return candidates
}

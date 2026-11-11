// A run's files in `<analysis>/queries/`: the listing, each run's header and result, and one run's code, rows and
// plots for the tabs. Runs are immutable, so what is final is kept by path.
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { parseLineage } from '../core/lineage.ts'
import { parseCsv, parseRunHeader, parseRunResult, parseRuns } from '../core/runs.ts'
import type { ResultStatus, Run, RunHeader } from '../core/runs.ts'
import { countSteps, parseSteps, stepFiles } from '../core/steps.ts'
import type { PlotResult, RunView } from '../shared/ipc.ts'
import { isMissing, messageOf, readHead, readText } from './fsAccess.ts'

export const QUERIES = 'queries'
/** Written by the mod when the app started it. */
export const RUN_STATUS = '.assay/runs.json'

const HEADER_BYTES = 2048
const MAX_DATA_ROWS = 1000
const MAX_DATA_BYTES = 4 * 1024 * 1024
const MAX_CODE_BYTES = 512 * 1024
const MAX_PLOT_BYTES = 20 * 1024 * 1024

// Runs are immutable, so a parsed header is kept by path and never read again.
const headers = new Map<string, RunHeader>()

/** File names in `queries/`, which fact labels are derived from. */
export async function readQueryNames(folder: string): Promise<string[]> {
  try {
    return await readdir(join(folder, QUERIES))
  } catch {
    return []
  }
}

/** The header of a run's code file, read once it is final; undefined when the file cannot be read. */
async function headerOf(path: string, run: Run): Promise<RunHeader | undefined> {
  const kept = headers.get(path)
  if (kept) return kept
  try {
    const { text, cut } = await readHead(path, HEADER_BYTES)
    const header = parseRunHeader(text, run.language)
    // The mod may still be writing the file: only a finished one (ends in a newline, or is longer than the head read) is kept.
    if (text.endsWith('\n') || (cut && text !== '')) headers.set(path, header)
    return header
  } catch {
    return undefined
  }
}

/** Fills each run's author, origin, trusted name and engine from the first 2 KB of its code file. */
async function withHeaders(folder: string, runs: Run[]): Promise<Run[]> {
  return Promise.all(
    runs.map(async run => {
      if (!run.code) return run
      const header = await headerOf(join(folder, QUERIES, run.code), run)
      if (!header) return run
      const { author, from, replay, trusted, engine } = header
      return {
        ...run,
        author,
        engine,
        ...(from !== undefined && { from }),
        ...(replay !== undefined && { replay }),
        ...(trusted !== undefined && { trusted }),
      }
    }),
  )
}

// A Python run's status is final once its `.json` says so; a running one is read again on every push.
// Keyed by the full file path, which includes the analysis folder, so analyses and windows never share entries.
const finished = new Map<string, ResultStatus>()

/** A SQL run with the number of steps its `NNN.steps.json` and step files name (docs/slice-9.md). */
async function withSteps(folder: string, run: Run, names: readonly string[]): Promise<Run> {
  const stepsFile = `${run.label}.steps.json`
  const file = names.includes(stepsFile) ? parseSteps(await readText(join(folder, QUERIES, stepsFile)).catch(() => '')) : undefined
  const steps = countSteps(names, run.number, file)
  return steps > 0 ? { ...run, steps } : run
}

/** A Python run with the status its result `.json` says. */
async function withStatus(folder: string, run: Run): Promise<Run> {
  if (!run.result) return run
  const path = join(folder, QUERIES, run.result)
  let status = finished.get(path)
  if (!status) {
    const result = parseRunResult(await readText(path).catch(() => ''))
    if (!result) return run
    status = result.status
    if (status !== 'running') finished.set(path, status)
  }
  return { ...run, status }
}

/**
 * Fills each Python run's `status` from its result `.json` (rewritten every 0.5 s by rename while it runs), and each
 * SQL run's `steps` from its `NNN.steps.json` (docs/slice-9.md).
 */
export async function withResults(folder: string, runs: Run[], names: readonly string[]): Promise<Run[]> {
  return Promise.all(runs.map(run => (run.language === 'python' ? withStatus(folder, run) : withSteps(folder, run, names))))
}

/** The runs listed in `queries/`, with headers and statuses. */
export async function readRunsWithHeaders(folder: string, queries: readonly string[]): Promise<Run[]> {
  return withResults(folder, await withHeaders(folder, parseRuns(queries)), queries)
}

/** The runs with statuses, for deriving the label a note citing a run gets. */
export async function readRuns(folder: string): Promise<Run[]> {
  const names = await readQueryNames(folder)
  return withResults(folder, parseRuns(names), names)
}

/** `NNN.notices.json`: the run's SQL rule and retype warnings; undefined when missing or unreadable. */
export function parseNotices(text: string): { rules: string[]; retype: string[] } | undefined {
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return undefined
    const list = (key: string) => {
      const value: unknown = Reflect.get(parsed, key)
      return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []
    }
    return { rules: list('rules'), retype: list('retype') }
  } catch {
    return undefined
  }
}

async function readTable(dir: string, file: string) {
  const { text, cut } = await readHead(join(dir, file), MAX_DATA_BYTES)
  // A cut file may end mid-row: drop the partial last line.
  const table = parseCsv(cut ? text.slice(0, text.lastIndexOf('\n') + 1) : text, MAX_DATA_ROWS)
  return { ...table, truncated: table.truncated || cut }
}

/** What the server wrote next to a run, and the run's code and rows (docs/slice-9.md, docs/slice-10.md). */
async function readRunFiles(dir: string, run: Run, view: RunView) {
  // Written by the server next to the run when the Steps tab asked (docs/slice-9.md); not a run file.
  const lineage = parseLineage(await readText(join(dir, `${run.label}.lineage.json`)))
  if (lineage) view.lineage = lineage
  const steps = parseSteps(await readText(join(dir, `${run.label}.steps.json`)))
  if (steps) view.steps = steps
  if (run.code) view.code = (await readHead(join(dir, run.code), MAX_CODE_BYTES)).text
  // A run with includes (docs/slice-10.md): the SQL that ran, saved beside it.
  const expanded = await readText(join(dir, `${run.label}.expanded.sql`))
  if (expanded) view.expanded = expanded
  const notices = parseNotices(await readText(join(dir, `${run.label}.notices.json`)))
  if (notices) view.notices = notices
  if (run.data) view.table = await readTable(dir, run.data)
}

/** The rows of step `k`: its own file, or the run's rows for the last step, which is the final SELECT. */
async function readStepTable(dir: string, names: readonly string[], view: RunView, k: number) {
  const planned = view.steps?.steps.find(each => each.k === k)
  const file = stepFiles(names, view.run.number).find(each => each.k === k)?.csv
  if (file) view.stepTable = await readTable(dir, file)
  else if (planned && planned.k === view.steps?.steps.length && planned.name === 'final' && view.table) view.stepTable = view.table
}

/** A Python run's result and the rows of its table number `k` (the first by default). */
async function readPythonResult(dir: string, run: Run, view: RunView, table: number | undefined) {
  const result = parseRunResult(await readText(join(dir, run.result ?? '')))
  if (result) {
    view.result = result
    view.run = { ...run, status: result.status }
  }
  const k = table ?? 1
  const file = run.tables[k - 1]
  if (file !== undefined) {
    view.tableIndex = k
    view.table = await readTable(dir, file)
  }
}

/** One run's code and saved result. The number is looked up in the folder listing, so no renderer path is used. */
export async function readRun(folder: string, number: number, options: { table?: number; step?: number } = {}): Promise<RunView | undefined> {
  const names = await readQueryNames(folder)
  const run = parseRuns(names).find(r => r.number === number)
  if (!run) return undefined
  const dir = join(folder, QUERIES)
  const view: RunView = { run }
  try {
    await readRunFiles(dir, run, view)
    if (options.step !== undefined) await readStepTable(dir, names, view, options.step)
    if (run.result) await readPythonResult(dir, run, view, options.table)
  } catch (err) {
    view.error = `Could not read: ${messageOf(err)}`
  }
  return view
}

/** Plot K (1-based) of a Python run as a data URL. The file is found in the listing, so only a `queries/` name can be read. */
export async function readPlot(folder: string, number: number, k: number): Promise<PlotResult> {
  const run = parseRuns(await readQueryNames(folder)).find(r => r.number === number)
  const file = run?.plots[k - 1]
  if (file === undefined) return { ok: false, message: 'No such plot' }
  try {
    const path = join(folder, QUERIES, file)
    if ((await stat(path)).size > MAX_PLOT_BYTES) return { ok: false, message: 'The plot is too large to show' }
    const mime = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
    return { ok: true, dataUrl: `data:${mime};base64,${(await readFile(path)).toString('base64')}` }
  } catch (err) {
    return { ok: false, message: isMissing(err) ? 'The plot file is not there yet' : `Could not read: ${messageOf(err)}` }
  }
}

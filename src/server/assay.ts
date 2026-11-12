// The server's state for one session in one analysis: its files, its runs and its kernel. Ported from the analysis
// mod's hooks/register.tsx, without the pane: the app draws everything, so what the mod kept for the pane is gone and
// what it wrote only inside the app (`.assay/runs.json`) is always written. Each kind of run is its own module:
// sqlRun.ts, pythonRun.ts (in kernel.ts's kernel), trustedRun.ts, and stepsRun.ts for a SQL run's lineage and steps.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { ANALYSIS_FILE } from '../core/analyses.ts'
import { dictionaryText, newSeen } from '../core/calculations.ts'
import type { CalculationList, DictionaryAnswer, Seen } from '../core/calculations.ts'
import type { Table } from '../core/engines.ts'
import { formatTable, queryLabel, toCsv } from '../core/pythonRuns.ts'
import type { UserRun } from '../core/rules.ts'
import { nextRunNumber, parseRuns } from '../core/runs.ts'
import { formatThreads, parseThreads } from '../core/threads.ts'
import type { Threads } from '../core/threads.ts'
import { parseVenvBuild, venvHint, venvStatusPath } from '../core/venv.ts'
import { KernelHost } from './kernel.ts'
import type { Proc } from './proc.ts'

export const THREADS = 'threads.md'
export const QUERIES = 'queries'
const LIB = 'lib'
const TESTS = 'tests'
const REPLY_ROWS = 50
const REPLY_CELL = 80
const HELPER_MS = 30_000
const LISTED_MS = 20_000
/** The last lines of a failed helper's output that its error keeps. */
const HELPER_LINES = 3

/** Run status for the app: which run is running and which failed this session, and the kernel's state. */
const APP_STATUS = '.assay/runs.json'
/** For the UserPromptSubmit hook: the user's runs since the last prompt, and the kernel's python. */
export const USER_RUNS = '.assay/user-runs.json'
/** For the same hook: the step checks that failed since the last prompt, one line each (docs/slice-9.md). */
export const STEP_NOTICES = '.assay/step-notices.json'

export type Config = {
  /** The analysis folder (ASSAY_ANALYSIS), absolute. */
  analysis: string
  /** The shared folder holding dictionaries/ and trusted/ (ASSAY_ROOT), absolute. */
  root: string
  /** Assay's venv (ASSAY_VENV), which runs every tool: `<venv>/bin/python`. */
  venv: string
  /** `analysis_kernel.py`, run by path. */
  runner: string
  /** Where the kernel's connection file goes. */
  tmp: string
  proc: Proc
  /** The commit that last changed trusted calculation `name` in the shared folder; without it stale cannot be checked. */
  currentCommit?: (name: string) => Promise<string | undefined>
}

type Query = { number: number; slug: string; hasCsv: boolean; language: 'sql' | 'python' }
type Running = { number: number; startedAt: number } | null

/** How one query runs: what its file saves, and what runs it once saved. */
export type Runner = {
  slug: string
  saved: string
  run: (file: string, number: number) => Promise<Table | { error: string } | { reply: string }>
  ext?: 'sql' | 'py'
  noun?: 'Query' | 'Run'
  onClaim?: (number: number) => void
  hasTables: boolean
  named?: string
  /** A line before the reply, e.g. what the query is built from. */
  preface?: string
  /** The file the dictionary text is read from, when not the saved run (the expanded SQL of a run with includes). */
  dictionaryFile?: (number: number) => string
}

/** A queue: each piece of work starts when the one before it settled. */
function queue() {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const done = last.then(work, work)
    last = done.catch(() => undefined)
    return done
  }
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A query's rows as the reply shows them: at most 50, and where the rest are. */
function tableReply(named: string, table: Table, csv: string) {
  const total = table.rows.length
  const shown = table.rows.slice(0, REPLY_ROWS)
  const lines = [`${named}: ${String(total)} ${total === 1 ? 'row' : 'rows'}. Columns: ${table.columns.join(', ')}`]
  if (total > 0) lines.push(formatTable(table.columns, shown, REPLY_CELL))
  if (total > shown.length) lines.push(`Truncated: showing ${String(shown.length)} of ${String(total)} rows. The app and ${csv} have all of them.`)
  return lines.join('\n')
}

export class Assay {
  readonly config: Config
  /** The dictionary entries and glossary terms this session has been given. */
  seen: Seen = newSeen()
  /** Why the runs of this session failed, by number. */
  readonly failures = new Map<number, string>()
  readonly kernels: KernelHost
  /** How many runs this session has claimed a number for. */
  runsClaimed = 0
  /** Whether this session has been told to search the root notes. */
  searchHinted = false
  private lastRunning: Running = null
  /** Every write to threads.md, analysis.yaml and a new run's number goes through here, one at a time. */
  readonly serially = queue()
  /** Python runs go one at a time, in arrival order. */
  readonly inKernel = queue()
  private appends = queue()
  private listed: { at: number; list: CalculationList | { error: string } } | undefined

  constructor(config: Config) {
    this.config = config
    this.kernels = new KernelHost(this)
  }

  at(path: string) {
    return join(this.config.analysis, path)
  }

  /** A file in the analysis as a reply names it: relative to the root, where Claude's working directory is. */
  shown(path: string) {
    return relative(this.config.root, this.at(path))
  }

  /** Whether the folder is an analysis (it holds analysis.yaml). Synchronous, so concurrent calls keep their order. */
  hasMarker() {
    return existsSync(this.at(ANALYSIS_FILE))
  }

  get python() {
    return `${this.config.venv}/bin/python`
  }

  readText(path: string): Promise<string> {
    return readFile(this.at(path), 'utf8').catch(() => '')
  }

  async write(path: string, text: string) {
    await mkdir(dirname(this.at(path)), { recursive: true })
    await writeFile(this.at(path), text, 'utf8')
  }

  /** Written to a temp file and renamed into place, so a reader never sees half of it. */
  async writeAtomic(path: string, text: string) {
    const full = this.at(path)
    await mkdir(dirname(full), { recursive: true })
    const temp = `${full}.${String(process.pid)}.tmp`
    await writeFile(temp, text, 'utf8')
    await rename(temp, full)
  }

  async exists(path: string) {
    return stat(path).then(
      () => true,
      () => false,
    )
  }

  async names(path: string): Promise<string[]> {
    return readdir(this.at(path)).catch(() => [])
  }

  /** Removes a file, ignoring one that is gone. */
  async remove(path: string) {
    await rm(path, { force: true }).catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Activation: what the mod did when the session started in an analysis.

  /** Creates whatever is missing (never overwriting): threads.md, queries/, lib/__init__.py, tests/. */
  async setUp() {
    // A folder without analysis.yaml is not an analysis (the migration makes it one): nothing is created in it.
    if (!this.hasMarker()) return
    for (const dir of [QUERIES, LIB, TESTS]) await mkdir(this.at(dir), { recursive: true })
    const give = async (name: string, text: string) => {
      if (!(await this.exists(this.at(name)))) await this.write(name, text)
    }
    await give(THREADS, formatThreads({ open: [], closed: [] }))
    await give(`${LIB}/__init__.py`, '')
    // .assay/ holds the app's session files; it ignores itself, so no repository needs a .gitignore change.
    await this.write('.assay/.gitignore', '*\n').catch(() => undefined)
  }

  /** Starts the session: the files, the kernel. (index.ts does the same around the handshake.) */
  async start() {
    await this.setUp()
    await this.kernels.start().catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Runs and labels.

  async listQueries(): Promise<Query[]> {
    return parseRuns(await this.names(QUERIES)).flatMap(run =>
      run.code === undefined && run.data === undefined && run.result === undefined
        ? []
        : [{ number: run.number, slug: run.slug, hasCsv: run.data !== undefined, language: run.language ?? 'sql' }],
    )
  }

  static queryBase(query: { number: number; slug: string }) {
    return `${QUERIES}/${queryLabel(query.number)}_${query.slug}`
  }

  static codeFile(query: Query) {
    return `${Assay.queryBase(query)}.${query.language === 'python' ? 'py' : 'sql'}`
  }

  editThreads<T>(change: (threads: Threads) => { threads: Threads; answer: T }) {
    return this.serially(async () => {
      const before = parseThreads(await this.readText(THREADS))
      const { threads, answer } = change(before)
      if (threads !== before) await this.write(THREADS, formatThreads(threads))
      return answer
    })
  }

  /** `.assay/runs.json`: the running run, this session's failures and the kernel's state. */
  async writeAppStatus(running: Running) {
    this.lastRunning = running
    const kernel = this.kernels.current
    const status = {
      running,
      failed: Object.fromEntries(this.failures),
      // Absent until a kernel was ever started.
      ...(kernel ? { kernel: { state: kernel.state, ...(kernel.message ? { message: kernel.message } : {}) } } : {}),
    }
    await this.writeAtomic(APP_STATUS, `${JSON.stringify(status, null, 2)}\n`).catch(() => undefined)
  }

  /** `.assay/runs.json` again, the running run as it was: the kernel's state changed. */
  rewriteAppStatus() {
    return this.writeAppStatus(this.lastRunning)
  }

  /** Appends `item` to the JSON list in `path`, one write at a time; a missing or unreadable list starts again. */
  append(path: string, item: unknown) {
    return this.appends(async () => {
      let items: unknown[] = []
      try {
        const parsed: unknown = JSON.parse(await this.readText(path))
        if (Array.isArray(parsed)) items = parsed
      } catch {
        // None yet, or the hook took them.
      }
      await this.writeAtomic(path, `${JSON.stringify([...items, item])}\n`).catch(() => undefined)
    })
  }

  /** Records a run the user made from the app, for the next prompt's notice. */
  recordUserRun(run: UserRun) {
    return this.append(USER_RUNS, run)
  }

  /** Saves a run under the next number, runs it and keeps its result; the tool's reply. */
  async runQuery(runner: Runner): Promise<string> {
    const ext = runner.ext ?? 'sql'
    const { base, number } = await this.claim(runner, ext)
    const outcome = await runner.run(`${base}.${ext}`, number).catch((error: unknown) => ({ error: message(error) }))
    if ('error' in outcome) this.failures.set(number, outcome.error)
    // No columns is a statement with no result set (CREATE VIEW, DROP): an empty .csv, which a failed run never has.
    else if ('columns' in outcome) await this.write(`${base}.csv`, outcome.columns.length === 0 ? '' : toCsv(outcome.columns, outcome.rows))
    await this.writeAppStatus(null)
    if ('reply' in outcome) return outcome.reply
    const dictionary = runner.hasTables ? await this.dictionaryFor(runner.dictionaryFile?.(number) ?? `${base}.sql`).catch(() => undefined) : undefined
    const named = `${runner.noun ?? 'Query'} ${queryLabel(number)}${runner.named ?? ''}`
    let text: string
    const savedAs = this.shown(`${base}.${ext}`)
    if ('error' in outcome) text = `${named} failed (saved ${savedAs}):\n${outcome.error}`
    else if (outcome.columns.length === 0) text = `${named}: ok, no result set.`
    else text = tableReply(named, outcome, this.shown(`${base}.csv`))
    const preface = runner.preface ? `${runner.preface}\n` : ''
    return preface + (dictionary ? `${text}\n\n${dictionary}` : text)
  }

  /** The next number, claimed inside the queue by saving the run's file before another call looks. */
  private claim(runner: Runner, ext: string) {
    return this.serially(async () => {
      const claimed = { number: nextRunNumber(await this.names(QUERIES)), slug: runner.slug }
      this.runsClaimed++
      // Before the file, so the app never sees the new run without knowing it runs.
      await this.writeAppStatus({ number: claimed.number, startedAt: Date.now() })
      runner.onClaim?.(claimed.number)
      await this.write(`${Assay.queryBase(claimed)}.${ext}`, runner.saved)
      return { base: Assay.queryBase(claimed), number: claimed.number }
    })
  }

  // -------------------------------------------------------------------------
  // The helpers: `python -m analysis_trust <command>` (or another module) with Assay's venv's python.

  /**
   * The tools' python, once the venv is built. uv makes `bin/python` before it installs the packages, and a failed
   * build leaves it behind, so the app's status file decides; a launcher's venv has none, and its python is enough.
   */
  async toolsPython(): Promise<string | undefined> {
    const build = await this.venvBuild()
    if (build && build.state !== 'ready') return undefined
    return (await this.exists(this.python)) ? this.python : undefined
  }

  private async venvBuild() {
    return parseVenvBuild(await readFile(venvStatusPath(this.config.venv), 'utf8').catch(() => undefined))
  }

  /** Why the tools' python is missing: the venv is still building, its build failed, or it was never built. */
  async venvHint(): Promise<string> {
    return venvHint(await this.venvBuild())
  }

  async helper<T>(args: readonly string[], timeoutMs = HELPER_MS, module = 'analysis_trust', input?: string): Promise<T | { error: string }> {
    const python = await this.toolsPython()
    if (!python) return { error: await this.venvHint() }
    const ran = await this.config.proc
      .run([python, '-I', '-m', module, ...args], { cwd: this.config.analysis, timeoutMs, ...(input === undefined ? {} : { input }) })
      .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: message(error) }))
    try {
      const parsed: unknown = JSON.parse(ran.stdout)
      if (parsed && typeof parsed === 'object') return parsed as T | { error: string }
    } catch {
      // Not JSON: say what it printed instead.
    }
    const said = ran.stderr.trim() || ran.stdout.trim() || `${module} exited with ${String(ran.exitCode)}`
    return { error: said.split('\n').slice(-HELPER_LINES).join(' ') }
  }

  /** The dictionary text for the tables a saved query touches, the first time this session touches each. */
  async dictionaryFor(sqlFile: string): Promise<string | undefined> {
    const answer = await this.helper<DictionaryAnswer>(['dictionary', this.config.root, this.at(sqlFile)])
    // A statement sqlglot cannot parse, or no venv: the query's own result stands alone.
    if ('error' in answer) return undefined
    return dictionaryText(answer, this.seen)
  }

  /** The trusted calculations in the shared folder (kept 20 s), or why they could not be listed. */
  async calculations(fresh = false): Promise<CalculationList | { error: string }> {
    if (!fresh && this.listed && Date.now() - this.listed.at < LISTED_MS) return this.listed.list
    const list = await this.helper<CalculationList>(['list', this.config.root])
    this.listed = { at: Date.now(), list }
    return list
  }

  forgetCalculations() {
    this.listed = undefined
  }
}

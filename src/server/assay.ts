// The server's state for one session in one analysis: its files, its runs and its kernel. Ported from the analysis
// mod's hooks/register.tsx, without the pane: the app draws everything, so what the mod kept for the pane is gone and
// what it wrote only inside the app (`.assay/runs.json`) is always written.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { ANALYSIS_FILE } from '../core/analyses.ts'
import { dictionaryText, newSeen, TRUSTED } from '../core/calculations.ts'
import type { CalculationList, DictionaryAnswer, Seen } from '../core/calculations.ts'
import { checkArgs, runHeader, signature } from '../core/calculations.ts'
import { parseCliOutput, parsePsqlOutput, POSTGRES_MARK, readTarget } from '../core/engines.ts'
import type { Table, Target } from '../core/engines.ts'
import { formatPythonRun, formatTable, parsePythonRun, queryLabel, runSlug, splitKernelEvents, toCsv, venvCandidates } from '../core/pythonRuns.ts'
import type { KernelEvent, KernelState, PythonRun } from '../core/pythonRuns.ts'
import { TRUST_TAB } from '../core/calculations.ts'
import { VENV_ASSAY_HINT } from '../core/rules.ts'
import type { UserRun } from '../core/rules.ts'
import type { Engine } from '../core/runs.ts'
import { codeBody, nextRunNumber, parseRunHeader, parseRuns } from '../core/runs.ts'
import type { LineageFile } from '../core/lineage.ts'
import { formatThreads, parseThreads } from '../core/threads.ts'
import type { Threads } from '../core/threads.ts'
import type { Child, Proc } from './proc.ts'

export const THREADS = 'threads.md'
export const QUERIES = 'queries'
const LIB = 'lib'
const TESTS = 'tests'
const REPLY_ROWS = 50
const REPLY_CELL = 80
export const QUERY_TIMEOUT_MS = 600_000
const PYTHON_TIMEOUT_MS = 600_000
const PYTHON_TIMEOUT_S = 590
const KERNEL_READY_MS = 120_000

/** Run status for the app: which run is running and which failed this session, and the kernel's state. */
const APP_STATUS = '.assay/runs.json'
/** For the UserPromptSubmit hook: the user's runs since the last prompt, and the kernel's python. */
export const USER_RUNS = '.assay/user-runs.json'
export const SESSION = '.assay/session.json'

export type Config = {
  /** The analysis folder (ASSAY_ANALYSIS), absolute. */
  analysis: string
  /** The shared folder holding dictionaries/ and trusted/ (ASSAY_ROOT), absolute. */
  root: string
  /** venv-assay, which runs every tool: `<venv>/bin/python`. */
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

type Kernel = {
  generation: number
  state: KernelState
  message?: string
  pid?: number
  python?: string
  connection?: string
  /** Settles once the serve process said ready, dead or missing (or ended). */
  ready: Promise<void>
  markReady: () => void
  stop?: () => void
  /** How many runs are in this kernel now: it is busy while any is. */
  runs: number
}

/** How one query runs: what its file saves, and what runs it once saved. */
type Runner = {
  slug: string
  saved: string
  run: (file: string, number: number) => Promise<Table | { error: string } | { reply: string }>
  ext?: 'sql' | 'py'
  noun?: 'Query' | 'Run'
  onClaim?: (number: number) => void
  hasTables: boolean
  named?: string
}

/** What `python -m analysis_sql lint` prints: rule breaks that stop the query, and warnings that do not. */
export type SqlLint = { errors: string[]; warnings: string[] }
export const SQL_RULES_REJECTED = 'Not run: the query breaks the SQL rules. Fix and send again:'

export type PythonOutcome = { text: string; number?: number; status?: PythonRun['status'] }

/** A queue: each piece of work starts when the one before it settled. */
function queue() {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const done = last.then(work, work)
    last = done.catch(() => undefined)
    return done
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class Assay {
  readonly config: Config
  /** The dictionary entries and glossary terms this session has been given. */
  seen: Seen = newSeen()
  /** Why the runs of this session failed, by number. */
  readonly failures = new Map<number, string>()
  kernel: Kernel | undefined
  /** How many runs this session has claimed a number for. */
  runsClaimed = 0
  /** Whether this session has been told to search the root notes. */
  searchHinted = false
  private kernelGenerations = 0
  private lastRunning: { number: number; startedAt: number } | null = null
  /** Every write to threads.md, analysis.yaml and a new run's number goes through here, one at a time. */
  readonly serially = queue()
  /** Python runs go one at a time, in arrival order. */
  readonly inKernel = queue()
  private userRunWrites = queue()
  private listed: { at: number; list: CalculationList | { error: string } } | undefined

  constructor(config: Config) {
    this.config = config
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
    const temp = `${full}.${process.pid}.tmp`
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
    await this.startKernel().catch(() => undefined)
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
  async writeAppStatus(running: { number: number; startedAt: number } | null) {
    this.lastRunning = running
    const kernel = this.kernel
    const status = {
      running,
      failed: Object.fromEntries(this.failures),
      // Absent until a kernel was ever started.
      ...(kernel ? { kernel: { state: kernel.state, ...(kernel.message ? { message: kernel.message } : {}) } } : {}),
    }
    await this.writeAtomic(APP_STATUS, `${JSON.stringify(status, null, 2)}\n`).catch(() => undefined)
  }

  /** Records a run the user made from the app, for the next prompt's notice. */
  recordUserRun(run: UserRun) {
    return this.userRunWrites(async () => {
      let runs: UserRun[] = []
      try {
        const parsed: unknown = JSON.parse(await this.readText(USER_RUNS))
        if (Array.isArray(parsed)) runs = parsed as UserRun[]
      } catch {
        // None yet, or the hook took them.
      }
      await this.writeAtomic(USER_RUNS, `${JSON.stringify([...runs, run])}\n`).catch(() => undefined)
    })
  }

  /** Saves a run under the next number, runs it and keeps its result; the tool's reply. */
  async runQuery(runner: Runner): Promise<string> {
    const { slug } = runner
    const ext = runner.ext ?? 'sql'
    // Saving the file inside the queue claims its number before another call looks.
    const { base, number } = await this.serially(async () => {
      const claimed = { number: nextRunNumber(await this.names(QUERIES)), slug }
      this.runsClaimed++
      // Before the file, so the app never sees the new run without knowing it runs.
      await this.writeAppStatus({ number: claimed.number, startedAt: Date.now() })
      runner.onClaim?.(claimed.number)
      await this.write(`${Assay.queryBase(claimed)}.${ext}`, runner.saved)
      return { base: Assay.queryBase(claimed), number: claimed.number }
    })
    const label = queryLabel(number)
    const outcome = await runner.run(`${base}.${ext}`, number).catch((error: unknown) => ({ error: message(error) }))

    if ('error' in outcome) this.failures.set(number, outcome.error)
    else if ('columns' in outcome) await this.write(`${base}.csv`, toCsv(outcome.columns, outcome.rows))
    await this.writeAppStatus(null)
    if ('reply' in outcome) return outcome.reply
    const dictionary = runner.hasTables ? await this.dictionaryFor(`${base}.sql`).catch(() => undefined) : undefined
    const withDictionary = (text: string) => (dictionary ? `${text}\n\n${dictionary}` : text)
    const named = `${runner.noun ?? 'Query'} ${label}${runner.named ?? ''}`
    if ('error' in outcome) return withDictionary(`${named} failed (saved ${this.shown(`${base}.${ext}`)}):\n${outcome.error}`)

    const total = outcome.rows.length
    const shown = outcome.rows.slice(0, REPLY_ROWS)
    const lines = [`${named}: ${total} ${total === 1 ? 'row' : 'rows'}. Columns: ${outcome.columns.join(', ')}`]
    if (total > 0) lines.push(formatTable(outcome.columns, shown, REPLY_CELL))
    if (total > shown.length) lines.push(`Truncated: showing ${shown.length} of ${total} rows. The app and ${this.shown(`${base}.csv`)} have all of them.`)
    return withDictionary(lines.join('\n'))
  }

  /** The command that runs a saved query, and how to read what it prints. */
  static queryCommand(engine: Engine, target: Target, file: string) {
    if (engine === 'postgres') {
      // rds-psql (the sandbox image) signs an IAM token for $PGHOST and opens a read-only session.
      return {
        argv: ['rds-psql', '-X', '--csv', '-v', 'ON_ERROR_STOP=1', ...(target.pgDatabase ? ['-d', target.pgDatabase] : []), '-f', file],
        read: (ran: { exitCode: number; stdout: string; stderr: string }) => parsePsqlOutput(ran.exitCode, ran.stdout, ran.stderr),
      }
    }
    // The trailing `SELECT 1` makes it a multi-query run, whose JSON names the columns even when the query returns no rows.
    return {
      argv: ['databricks', 'experimental', 'aitools', 'tools', 'query', '--profile', target.profile, '--warehouse', target.warehouse, '--output', 'json', '--file', file, 'SELECT 1'],
      read: (ran: { stdout: string; stderr: string }) => parseCliOutput(ran.stdout, ran.stderr),
    }
  }

  runSql(sql: string, slugText: string, engine: Engine, header = '', onClaim?: (number: number) => void): Promise<string> {
    return this.runQuery({
      slug: runSlug(slugText),
      saved: `${header}${engine === 'postgres' ? `${POSTGRES_MARK}\n` : ''}${sql.trim()}\n`,
      ...(onClaim ? { onClaim } : {}),
      hasTables: engine === 'databricks',
      run: async sqlFile => {
        const command = Assay.queryCommand(engine, readTarget(await this.readText(ANALYSIS_FILE)), sqlFile)
        const ran = await this.config.proc.run(command.argv, { cwd: this.config.analysis, timeoutMs: QUERY_TIMEOUT_MS })
        return ran.isStdoutTruncated ? { error: 'The result is over 4 MiB. Aggregate it or add a LIMIT.' } : command.read(ran)
      },
    })
  }

  // -------------------------------------------------------------------------
  // The helpers: `python -m analysis_trust <command>` with venv-assay's python.

  async toolsPython(): Promise<string | undefined> {
    return (await this.exists(this.python)) ? this.python : undefined
  }

  async helper<T>(args: readonly string[], timeoutMs = 30_000, module = 'analysis_trust', input?: string): Promise<T | { error: string }> {
    const python = await this.toolsPython()
    if (!python) return { error: VENV_ASSAY_HINT }
    const ran = await this.config.proc
      .run([python, '-m', module, ...args], { cwd: this.config.analysis, timeoutMs, ...(input === undefined ? {} : { input }) })
      .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: message(error) }))
    try {
      const parsed: unknown = JSON.parse(ran.stdout)
      if (parsed && typeof parsed === 'object') return parsed as T | { error: string }
    } catch {
      // Not JSON: say what it printed instead.
    }
    return { error: (ran.stderr.trim() || ran.stdout.trim() || `${module} exited with ${ran.exitCode}`).split('\n').slice(-3).join(' ') }
  }

  /** The SQL rules' verdict on Claude's statement (docs/slice-9.md); undefined for one with no WITH and no JOIN. */
  async lintSql(sql: string, engine: Engine): Promise<SqlLint | { error: string } | undefined> {
    if (!/\b(with|join)\b/i.test(sql)) return undefined
    const found = await this.helper<SqlLint>(['lint', engine], 30_000, 'analysis_sql', sql)
    if ('error' in found) return found
    return Array.isArray(found.errors) && Array.isArray(found.warnings) ? found : { error: 'analysis_sql printed no errors and warnings' }
  }

  /**
   * Writes `queries/NNN.lineage.json` for SQL run `number` (docs/slice-9.md): the CTE graph from `analysis_sql lineage`,
   * or `{error}` when there is none. Undefined on success, else why the run has no file to write for.
   */
  async lineage(number: number): Promise<string | undefined> {
    const run = parseRuns(await this.names(QUERIES)).find(each => each.number === number)
    if (run?.code === undefined) return `No run ${queryLabel(number)}.`
    const write = (answer: LineageFile | { error: string }) => this.writeAtomic(`${QUERIES}/${queryLabel(number)}.lineage.json`, `${JSON.stringify(answer)}\n`)
    const text = await this.readText(`${QUERIES}/${run.code}`)
    const header = parseRunHeader(text, run.language)
    const body = codeBody(text, run.language === 'python' ? 'python' : 'sql')
    if (run.language === 'python' || (header.trusted && /^-- python:/m.test(body))) {
      await write({ error: 'Steps reads SQL runs.' })
      return undefined
    }
    // A trusted run's body is the template, with its `:name` parameters.
    const args = ['lineage', header.engine, ...(header.trusted ? ['--template'] : [])]
    const found = await this.helper<LineageFile>(args, 30_000, 'analysis_sql', body)
    await write(found)
    return undefined
  }

  /** Claude's `sql` call: the rules first. A rejected statement claims no number and records no run. */
  async runClaudeSql(sql: string, slugText: string, engine: Engine): Promise<string> {
    const linted = await this.lintSql(sql, engine)
    if (linted && !('error' in linted) && linted.errors.length > 0) {
      return [SQL_RULES_REJECTED, ...linted.errors.map(line => `- ${line}`)].join('\n')
    }
    const reply = await this.runSql(sql, slugText, engine)
    if (!linted) return reply
    // A lint that cannot run does not block: the query ran, and the reply says why it was not checked.
    if ('error' in linted) return `${reply}\n\nSQL rules not checked: ${linted.error}`
    if (linted.warnings.length === 0) return reply
    return [reply, '', 'SQL rule warnings:', ...linted.warnings.map(line => `- ${line}`)].join('\n')
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
    if (!fresh && this.listed && Date.now() - this.listed.at < 20_000) return this.listed.list
    const list = await this.helper<CalculationList>(['list', this.config.root])
    this.listed = { at: Date.now(), list }
    return list
  }

  forgetCalculations() {
    this.listed = undefined
  }

  /** Runs a trusted calculation by name: arguments checked, bound by the helper, the run recorded like a query. */
  async runTrusted(name: string, given: unknown): Promise<string> {
    const list = await this.calculations(true)
    if ('error' in list) return `Cannot list the trusted calculations: ${list.error}`
    const calc = list.calculations.find(each => each.name === name)
    if (!calc) {
      const names = list.calculations.map(each => each.name)
      return `No trusted calculation ${name}. ${names.length ? `There are: ${names.join(', ')}.` : 'There are none yet.'}`
    }
    if (calc.dirty) {
      return `${calc.path ?? `${TRUSTED}/${calc.file}`} differs from its last commit, or was never committed: it is not trusted until the user approves it again in ${TRUST_TAB}. Write your own SQL instead, and say why.`
    }
    const checked = checkArgs(calc.parameters, given)
    if ('error' in checked) return `${checked.error} ${signature(calc)}`
    const home = this.config.root
    const header = runHeader({ name: calc.name, args: checked.args, commit: calc.commit })
    let body = calc.kind === 'python' ? `-- python: ${TRUSTED}/${calc.file}` : (calc.sql ?? '').trim()
    if (calc.kind === 'definition') {
      // The query a definition's run sends, built (and its names checked) by the helper.
      const rendered = await this.helper<{ sql: string }>(['render', home, calc.name, JSON.stringify(checked.args)])
      if ('error' in rendered) return `${rendered.error} ${signature(calc)}`
      body = rendered.sql
    }
    return this.runQuery({
      slug: runSlug(calc.name),
      saved: `${header}\n${body}\n`,
      hasTables: calc.kind !== 'python',
      named: ` (trusted ${calc.name})`,
      run: async () => {
        const ran = await this.helper<Table>(['run', home, calc.name, JSON.stringify(checked.args), this.config.analysis], QUERY_TIMEOUT_MS)
        return 'error' in ran ? ran : { columns: ran.columns.map(String), rows: ran.rows.map(row => row.map(String)) }
      },
    })
  }

  // -------------------------------------------------------------------------
  // The kernel: one `analysis_kernel.py serve` per session. Its stdout events keep `kernel` in runs.json; each
  // Python run is a short `analysis_kernel.py run` client against the kernel's connection file.

  private async setKernel(current: Kernel, patch: Partial<Pick<Kernel, 'state' | 'message' | 'pid'>>) {
    if (this.kernel !== current) return
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (current as Record<string, unknown>)[key]
      else (current as Record<string, unknown>)[key] = value
    }
    await this.writeAppStatus(this.lastRunning)
  }

  stopKernel() {
    this.kernel?.stop?.()
    if (this.kernel) delete this.kernel.stop
  }

  private async applyKernelEvent(current: Kernel, event: KernelEvent) {
    if (event.event === 'ready') {
      await this.setKernel(current, { state: current.runs > 0 ? 'busy' : 'idle', message: undefined, pid: event.pid })
      current.markReady()
    } else if (event.event === 'dead' || event.event === 'missing') {
      await this.setKernel(current, { state: event.event, message: event.message })
      current.markReady()
    }
  }

  /** The serve process's life: its events and its end. */
  private async superviseKernel(current: Kernel, child: Child) {
    let buffer = ''
    let stderr = ''
    let isStopped = false
    // Events are applied in order, one after another.
    let applying: Promise<unknown> = Promise.resolve()
    child.onOutput((stream, text) => {
      if (this.kernel !== current) return
      if (stream === 'stderr') {
        stderr = (stderr + text).slice(-2000)
        return
      }
      const parsed = splitKernelEvents(buffer + text)
      buffer = parsed.rest
      for (const event of parsed.events) {
        if (event.event === 'stopped') isStopped = true
        applying = applying.then(() => this.applyKernelEvent(current, event))
      }
    })
    const code = await child.exited
    await applying
    current.markReady()
    if (this.kernel !== current || isStopped || current.state === 'dead' || current.state === 'missing') return
    const why = stderr.trim().split('\n').slice(-3).join(' ') || `The kernel process ended${code === null ? '' : ` (exit ${code})`}.`
    await this.setKernel(current, { state: code === 2 ? 'missing' : 'dead', message: why })
  }

  /** The nearest project .venv/bin/python from `dir` up, if any. Only the kernel may use it. */
  private async findProjectPython(dir: string): Promise<string | undefined> {
    for (const candidate of venvCandidates(dir)) if (await this.exists(candidate)) return candidate
    return undefined
  }

  /** The kernel's python: the nearest project .venv's when it imports ipykernel (checked at each start), else venv-assay's. */
  async kernelPython(): Promise<string | undefined> {
    const project = await this.findProjectPython(this.config.analysis).catch(() => undefined)
    if (project) {
      const ran = await this.config.proc.run([project, '-c', 'import ipykernel'], { cwd: this.config.analysis, timeoutMs: 20_000 }).catch(() => undefined)
      if (ran?.exitCode === 0) return project
    }
    return this.toolsPython()
  }

  /** Starts the kernel, ending any earlier one. Returns once the serve process is spawned (or known missing). */
  async startKernel() {
    this.stopKernel()
    let markReady: () => void = () => undefined
    const ready = new Promise<void>(resolve => {
      markReady = resolve
    })
    const current: Kernel = { generation: ++this.kernelGenerations, state: 'starting', ready, markReady, runs: 0 }
    this.kernel = current
    await this.writeAppStatus(this.lastRunning)
    const python = await this.kernelPython()
    if (this.kernel === current && python) current.python = python
    // For the prompt hook, which names the kernel's python in the rules.
    await this.writeAtomic(SESSION, `${JSON.stringify({ python: python ?? null })}\n`).catch(() => undefined)
    if (!python) {
      await this.setKernel(current, { state: 'missing', message: VENV_ASSAY_HINT })
      current.markReady()
      return
    }
    const connection = join(this.config.tmp, `assay-kernel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    if (this.kernel !== current) return // a newer start replaced this one while it was looking around
    current.connection = connection
    const child = this.config.proc.spawn([python, this.config.runner, 'serve', '--analysis', this.config.analysis, '--connection', connection], { cwd: this.config.analysis })
    current.stop = () => child.kill()
    void this.superviseKernel(current, child)
  }

  /** Waits until the kernel has answered. A serve that never says ready is stopped and the kernel is dead. */
  async kernelSettled(readyMs = KERNEL_READY_MS) {
    for (let i = 0; i < 3 && this.kernel; i++) {
      const current = this.kernel
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>(resolve => {
        timer = setTimeout(() => resolve('late'), readyMs)
      })
      const outcome = await Promise.race([current.ready.then(() => 'ready' as const), late])
      clearTimeout(timer)
      if (outcome === 'late') {
        current.stop?.()
        await this.setKernel(current, { state: 'dead', message: `The kernel did not start within ${readyMs / 1000} s.` })
        current.markReady()
      }
      if (this.kernel === current) break
    }
  }

  /** The kernel made ready for a run, starting a new one if it died or was missing; or why there is none. */
  async readyKernel(): Promise<{ problem?: string; note?: string }> {
    let note: string | undefined
    if (!this.kernel || this.kernel.state === 'dead' || this.kernel.state === 'missing') {
      if (this.kernel?.state === 'dead') note = 'The kernel had died: this run is in a new kernel, so earlier variables are gone.'
      await this.startKernel()
    }
    await this.kernelSettled()
    const kernel = this.kernel
    if (kernel?.state === 'missing') return { problem: `The Python kernel is not available: ${kernel.message ?? 'missing'}` }
    if (kernel?.state !== 'idle' && kernel?.state !== 'busy') return { problem: `The Python kernel is not running: ${kernel?.message ?? kernel?.state ?? 'not started'}` }
    return note ? { note } : {}
  }

  /** Interrupts the run in the kernel (SIGUSR1 to its serve process); why not, if it cannot. */
  async interruptKernel(): Promise<string | undefined> {
    const current = this.kernel
    if (!current?.pid || (current.state !== 'busy' && current.state !== 'idle')) return 'No kernel is running.'
    const ran = await this.config.proc
      .run(['kill', '-USR1', String(current.pid)], { cwd: this.config.analysis })
      .catch((error: unknown) => ({ exitCode: 1, stderr: message(error) }))
    return ran.exitCode === 0 ? undefined : ran.stderr.trim() || 'The kernel could not be interrupted.'
  }

  /** A new kernel in place of this one; why not, if it did not come up. */
  async restartKernel(): Promise<string | undefined> {
    await this.startKernel()
    await this.kernelSettled()
    const kernel = this.kernel
    return kernel?.state === 'idle' || kernel?.state === 'busy' ? undefined : (kernel?.message ?? 'The kernel did not start.')
  }

  /** One Python run in the kernel as it stands (the caller holds the queue): saved, run, recorded; Claude's reply. */
  async runPythonNow(code: string, slugText: string, header: string): Promise<PythonOutcome> {
    const prepared = await this.readyKernel()
    if (prepared.problem) return { text: prepared.problem }
    const current = this.kernel
    if (!current?.python || !current.connection || !current.pid) {
      return { text: `The Python kernel is not running: it has no ${!current ? 'process' : !current.python ? 'python' : !current.connection ? 'connection file' : 'pid'}.` }
    }
    const { python, connection, pid } = current
    let number: number | undefined
    let status: PythonRun['status'] | undefined
    const text = await this.runQuery({
      slug: runSlug(slugText),
      saved: `${header}${code.trim()}\n`,
      ext: 'py',
      noun: 'Run',
      hasTables: false,
      onClaim: claimed => (number = claimed),
      run: async (file, claimed) => {
        const startedAt = Date.now()
        current.runs++
        await this.setKernel(current, { state: 'busy' })
        try {
          const argv = [python, this.config.runner, 'run', '--connection', connection, '--analysis', this.config.analysis, '--code-file', file, '--timeout', String(PYTHON_TIMEOUT_S), '--serve-pid', String(pid)]
          const ran = await this.config.proc
            .run(argv, { cwd: this.config.analysis, timeoutMs: PYTHON_TIMEOUT_MS })
            .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: message(error) }))
          const said = (ran.stderr.trim() || ran.stdout.trim() || `The kernel runner exited with ${ran.exitCode}.`).split('\n').slice(-5).join('\n')
          // Exit 3: the kernel could not be reached. The runner still prints a summary and saves an error .json.
          const parsed = ran.exitCode === 0 || ran.exitCode === 3 ? parsePythonRun(ran.stdout) : { error: said }
          if (ran.exitCode === 3) await this.setKernel(current, { state: 'dead', message: ('status' in parsed ? parsed.error?.message : parsed.error) || said })
          if (!('status' in parsed)) return parsed
          status = parsed.status
          return { reply: `${prepared.note ? `${prepared.note}\n` : ''}${formatPythonRun(claimed, parsed, Date.now() - startedAt, this.shown(QUERIES))}` }
        } finally {
          current.runs--
          if (current.runs === 0 && current.state === 'busy') await this.setKernel(current, { state: 'idle' })
        }
      },
    })
    return { text, ...(number === undefined ? {} : { number }), ...(status ? { status } : {}) }
  }

  runPython(code: string, slugText: string, header: string) {
    return this.inKernel(() => this.runPythonNow(code, slugText, header))
  }

  /** Removes a file, ignoring one that is gone. */
  async remove(path: string) {
    await rm(path, { force: true }).catch(() => undefined)
  }
}

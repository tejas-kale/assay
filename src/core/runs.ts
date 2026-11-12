// Runs are the files in an analysis's `queries/` folder: `NNN_<slug>.sql` (or `.py`) is the code,
// `NNN_<slug>.csv` the saved SQL result. A Python run's result is `NNN_<slug>.json` with its tables
// (`.tK.csv`) and plots (`.pK.png|svg`). One number names one run, so the Code and Data tabs link by it.

export type Engine = 'databricks' | 'postgres'

export type Run = {
  number: number
  /** The zero-padded number as written in the file name, such as `020`. */
  label: string
  slug: string
  /** File names inside `queries/`. */
  code?: string
  /** The SQL result `.csv` only. */
  data?: string
  /** A Python run's result `.json`. */
  result?: string
  /** A Python run's table and plot files, in K order. */
  tables: readonly string[]
  plots: readonly string[]
  language?: 'sql' | 'python'
  /** From the result `.json`; main fills it, `parseRuns` (names only) does not. */
  status?: ResultStatus
  /** From the code file's header; main fills these, `parseRuns` (names only) does not. */
  author?: 'user' | 'claude'
  from?: number
  replay?: number
  trusted?: string
  engine?: Engine
  /** How many steps a SQL run has (planned, or run); main fills it from `NNN.steps.json`. */
  steps?: number
}

const NAME = /^(\d+)_(.+?)(?:\.t(\d+)\.csv|\.p(\d+)\.(?:png|svg)|\.(sql|py|csv|json))$/

/** Every run in `queries/`, oldest first. Other files are ignored. */
export function parseRuns(names: readonly string[]): Run[] {
  const runs = new Map<number, Run>()
  const indexed = new Map<number, { tables: [number, string][]; plots: [number, string][] }>()
  for (const name of names) {
    const match = NAME.exec(name)
    if (!match) continue
    const [, label = '', slug = '', table, plot, ext] = match
    const number = Number(label)
    const run = runs.get(number) ?? { number, label, slug, tables: [], plots: [] }
    const files = indexed.get(number) ?? { tables: [], plots: [] }
    if (table !== undefined) files.tables.push([Number(table), name])
    else if (plot !== undefined) files.plots.push([Number(plot), name])
    else if (ext === 'csv') run.data = name
    else if (ext === 'json') run.result = name
    else {
      run.code = name
      run.language = ext === 'py' ? 'python' : 'sql'
      run.slug = slug
    }
    runs.set(number, run)
    indexed.set(number, files)
  }
  for (const [number, run] of runs) {
    const files = indexed.get(number)
    run.tables = (files?.tables ?? []).sort((a, b) => a[0] - b[0]).map(([, name]) => name)
    run.plots = (files?.plots ?? []).sort((a, b) => a[0] - b[0]).map(([, name]) => name)
  }
  return [...runs.values()].sort((a, b) => a.number - b.number)
}

export type ResultStatus = 'running' | 'ok' | 'error' | 'interrupted'
const RESULT_STATUSES: readonly unknown[] = ['running', 'ok', 'error', 'interrupted']

/** A Python run's `.json`, as the runner writes it (docs/slice-3.md). */
export type RunResult = {
  status: ResultStatus
  kernel?: string
  startedAt?: number
  endedAt?: number
  stdout: string
  stdoutTruncated?: true
  error?: { name: string; message: string; traceback: string }
  tables: { file: string; columns: string[]; rowCount: number; truncated: boolean }[]
  /** File names. */
  plots: string[]
  /** Run numbers the code read with `q(n)`. */
  reads: number[]
}

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null
const field = (v: object, key: string): unknown => Reflect.get(v, key)
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : [])

/** The table entries of a result; one with no file name is dropped. */
function resultTables(raw: object): RunResult['tables'] {
  const tables: RunResult['tables'] = []
  for (const t of list(field(raw, 'tables'))) {
    if (!isObject(t) || typeof field(t, 'file') !== 'string') continue
    const rowCount = field(t, 'rowCount')
    tables.push({
      file: str(field(t, 'file')),
      columns: list(field(t, 'columns')).filter((c): c is string => typeof c === 'string'),
      rowCount: typeof rowCount === 'number' ? rowCount : 0,
      truncated: field(t, 'truncated') === true,
    })
  }
  return tables
}

/** The optional scalar fields of a result: kernel, the two times and the truncation mark. */
function resultExtras(raw: object): Partial<RunResult> {
  const kernel = field(raw, 'kernel')
  const startedAt = field(raw, 'startedAt')
  const endedAt = field(raw, 'endedAt')
  const error = field(raw, 'error')
  return {
    ...(typeof kernel === 'string' && { kernel }),
    ...(typeof startedAt === 'number' && { startedAt }),
    ...(typeof endedAt === 'number' && { endedAt }),
    ...(field(raw, 'stdoutTruncated') === true && { stdoutTruncated: true as const }),
    ...(isObject(error) && { error: { name: str(field(error, 'name')), message: str(field(error, 'message')), traceback: str(field(error, 'traceback')) } }),
  }
}

/** Reads the `.json` safely: unknown fields are ignored; undefined when it is not a result. */
export function parseRunResult(text: string): RunResult | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw)) return undefined
  const status = field(raw, 'status')
  if (!RESULT_STATUSES.includes(status)) return undefined
  return {
    status: status as ResultStatus,
    ...resultExtras(raw),
    stdout: str(field(raw, 'stdout')),
    tables: resultTables(raw),
    plots: list(field(raw, 'plots')).flatMap(p => (isObject(p) && typeof field(p, 'file') === 'string' ? [str(field(p, 'file'))] : [])),
    reads: list(field(raw, 'reads')).filter((n): n is number => typeof n === 'number'),
  }
}

export type Table = { columns: string[]; rows: string[][]; truncated: boolean }

/** The CSV reader's position in a record: the finished records, the open one, the open field, and whether it is inside quotes. */
type CsvState = { records: string[][]; record: string[]; field: string; quoted: boolean }

function endRecord(state: CsvState) {
  state.record.push(state.field)
  state.field = ''
  if (!(state.record.length === 1 && state.record[0] === '')) state.records.push(state.record)
  state.record = []
}

/** Reads the character at `i`; says how many characters it used (a doubled quote or CR LF uses two) and whether a record ended. */
function readCsvChar(state: CsvState, text: string, i: number): { used: number; ended: boolean } {
  const ch = text.charAt(i)
  const next = text.charAt(i + 1)
  if (state.quoted) {
    if (ch !== '"') state.field += ch
    else if (next === '"') state.field += '"'
    else state.quoted = false
    return { used: ch === '"' && next === '"' ? 2 : 1, ended: false }
  }
  if (ch === '"') state.quoted = true
  else if (ch === ',') {
    state.record.push(state.field)
    state.field = ''
  } else if (ch === '\n' || ch === '\r') {
    endRecord(state)
    return { used: ch === '\r' && next === '\n' ? 2 : 1, ended: true }
  } else state.field += ch
  return { used: 1, ended: false }
}

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines. Stops after `maxRows` data rows. */
export function parseCsv(text: string, maxRows: number): Table {
  const state: CsvState = { records: [], record: [], field: '', quoted: false }
  let i = 0
  let truncated = false
  let stopped = false
  while (i < text.length && !stopped) {
    const { used, ended } = readCsvChar(state, text, i)
    i += used
    if (ended && state.records.length > maxRows) {
      truncated = i < text.length
      stopped = true
    }
  }
  if (!stopped && (state.field !== '' || state.record.length > 0)) endRecord(state)
  if (state.records.length > maxRows + 1) {
    state.records.length = maxRows + 1
    truncated = true
  }
  const [columns = [], ...rows] = state.records
  return { columns, rows, truncated }
}

/** What the mod writes to `.assay/runs.json` when the app started it: the running query and this session's failures. */
export type KernelState = 'starting' | 'idle' | 'busy' | 'dead' | 'missing'
const KERNEL_STATES: readonly unknown[] = ['starting', 'idle', 'busy', 'dead', 'missing']
export type RunStatus = {
  running?: { number: number; startedAt: number }
  failed: Record<number, string>
  /** Absent when no kernel was ever started. */
  kernel?: { state: KernelState; message?: string }
}

/** The object at `raw[key]`, when it is one. */
function objectField(raw: object, key: string): object | undefined {
  const value: unknown = Reflect.get(raw, key)
  return typeof value === 'object' && value !== null ? value : undefined
}

function runningOf(raw: object): RunStatus['running'] {
  const running = objectField(raw, 'running')
  if (!running) return undefined
  const number: unknown = Reflect.get(running, 'number')
  const startedAt: unknown = Reflect.get(running, 'startedAt')
  return typeof number === 'number' && typeof startedAt === 'number' ? { number, startedAt } : undefined
}

function failedOf(raw: object): RunStatus['failed'] {
  const failed: RunStatus['failed'] = {}
  for (const [key, message] of Object.entries(objectField(raw, 'failed') ?? {})) {
    if (/^\d+$/.test(key) && typeof message === 'string') failed[Number(key)] = message
  }
  return failed
}

function kernelOf(raw: object): RunStatus['kernel'] {
  const kernel = objectField(raw, 'kernel')
  if (!kernel) return undefined
  const state: unknown = Reflect.get(kernel, 'state')
  const message: unknown = Reflect.get(kernel, 'message')
  if (!KERNEL_STATES.includes(state)) return undefined
  return { state: state as KernelState, ...(typeof message === 'string' && message !== '' && { message }) }
}

export function parseRunStatus(text: string): RunStatus {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { failed: {} }
  }
  if (typeof raw !== 'object' || raw === null) return { failed: {} }
  const running = runningOf(raw)
  const kernel = kernelOf(raw)
  return { ...(running && { running }), failed: failedOf(raw), ...(kernel && { kernel }) }
}

export type RunHeader = {
  author: 'user' | 'claude'
  from?: number
  replay?: number
  trusted?: string
  engine: Engine
  /** The trusted pieces a run with includes is built from, as `name@commit` (docs/slice-10.md). */
  builtFrom?: string[]
}

const SQL_HEADER_LINE = /^-- (?:author: |from: |trusted: |commit: |args: |built from: |postgres\s*$)/
const PYTHON_HEADER_LINE = /^# (?:author: |from: |replay: )/

type HeaderValue = (key: string) => string | undefined

const isNumber = (text: string | undefined): text is string => text !== undefined && /^\d+$/.test(text)

/** The SQL-only header lines: the trusted name, what a run is built from, and the engine. */
function readSqlHeader(header: RunHeader, value: HeaderValue, line: string) {
  const trusted = value('trusted')
  if (trusted) header.trusted = trusted.split(/\s/)[0] ?? trusted
  const built = value('built from')
  if (built) header.builtFrom = built.split(',').map(piece => piece.trim()).filter(Boolean)
  if (/^-- postgres\s*$/.test(line)) header.engine = 'postgres'
}

/** The mod's header lines, read from the leading comment lines only (`-- ` for SQL, `# ` for Python). A run with no `author:` line is Claude's. */
export function parseRunHeader(text: string, language: 'sql' | 'python' = 'sql'): RunHeader {
  const header: RunHeader = { author: 'claude', engine: 'databricks' }
  const comment = language === 'python' ? '#' : '--'
  for (const line of text.split('\n')) {
    if (!line.startsWith(comment)) break
    const value: HeaderValue = key => (line.startsWith(`${comment} ${key}: `) ? line.slice(comment.length + key.length + 3).trim() : undefined)
    if (value('author') === 'user') header.author = 'user'
    const from = value('from')
    if (isNumber(from)) header.from = Number(from)
    if (language === 'python') {
      const replay = value('replay')
      if (isNumber(replay)) header.replay = Number(replay)
    } else readSqlHeader(header, value, line)
  }
  return header
}

/** The code with the leading header lines removed, so a re-run or an edit never copies them. */
export function codeBody(text: string, language: 'sql' | 'python'): string {
  const pattern = language === 'python' ? PYTHON_HEADER_LINE : SQL_HEADER_LINE
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && pattern.test(lines[i] ?? '')) i++
  return lines.slice(i).join('\n')
}

/**
 * Claude's code with every header-shaped line taken out of its leading comment lines, where the header is read: only
 * the server writes a run's header, so Claude's code cannot claim to be the user's or a trusted calculation's.
 */
export function withoutHeaderLines(code: string, language: 'sql' | 'python'): string {
  const comment = language === 'python' ? '#' : '--'
  const pattern = language === 'python' ? PYTHON_HEADER_LINE : SQL_HEADER_LINE
  const lines = code.split('\n')
  let end = 0
  while (end < lines.length && (lines[end] ?? '').startsWith(comment)) end++
  return [...lines.slice(0, end).filter(line => !pattern.test(line)), ...lines.slice(end)].join('\n')
}

export type RunLabel = 'trusted' | 'queried' | 'computed' | 'unverified' | 'running'

/** The trust label, as the mod's `deriveLabel`: no result is unverified, a trusted header is trusted, an ok Python run is computed. */
export function runLabel(run: Run, header: RunHeader, status: RunStatus): RunLabel {
  if (status.running?.number === run.number) return 'running'
  const cited = resultLabel(run)
  return cited === 'queried' && header.trusted ? 'trusted' : cited
}

/** The label a run's result earns: an ok Python run is computed, SQL with data is queried, anything else unverified. */
function resultLabel(run: Run): 'queried' | 'computed' | 'unverified' {
  if (run.language === 'python') return run.status === 'ok' ? 'computed' : 'unverified'
  return run.data ? 'queried' : 'unverified'
}

/** The label a note gets when it cites run `n` (never `trusted`: only an existing trusted note keeps that). */
export function citedLabel(runs: readonly Run[]): (n: number) => 'queried' | 'computed' | 'unverified' {
  return n => {
    const run = runs.find(r => r.number === n)
    return run ? resultLabel(run) : 'unverified'
  }
}

/** The Python run `.assay/runs.json` says is running, if any. */
export function runningPythonRun(runs: readonly Run[], status: RunStatus): Run | undefined {
  const number = status.running?.number
  const run = runs.find(r => r.number === number)
  return run?.language === 'python' ? run : undefined
}

/** The number the next run claims: the highest in `queries/` plus one. Numbers are never reused. */
export const nextRunNumber = (names: readonly string[]) => Math.max(0, ...parseRuns(names).map(run => run.number)) + 1

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
  const result: RunResult = {
    status: status as ResultStatus,
    stdout: str(field(raw, 'stdout')),
    tables: [],
    plots: [],
    reads: [],
  }
  const kernel = field(raw, 'kernel')
  if (typeof kernel === 'string') result.kernel = kernel
  const startedAt = field(raw, 'startedAt')
  if (typeof startedAt === 'number') result.startedAt = startedAt
  const endedAt = field(raw, 'endedAt')
  if (typeof endedAt === 'number') result.endedAt = endedAt
  if (field(raw, 'stdoutTruncated') === true) result.stdoutTruncated = true
  const error = field(raw, 'error')
  if (isObject(error)) {
    result.error = { name: str(field(error, 'name')), message: str(field(error, 'message')), traceback: str(field(error, 'traceback')) }
  }
  for (const t of list(field(raw, 'tables'))) {
    if (!isObject(t) || typeof field(t, 'file') !== 'string') continue
    const rowCount = field(t, 'rowCount')
    result.tables.push({
      file: str(field(t, 'file')),
      columns: list(field(t, 'columns')).filter((c): c is string => typeof c === 'string'),
      rowCount: typeof rowCount === 'number' ? rowCount : 0,
      truncated: field(t, 'truncated') === true,
    })
  }
  for (const p of list(field(raw, 'plots'))) if (isObject(p) && typeof field(p, 'file') === 'string') result.plots.push(str(field(p, 'file')))
  result.reads = list(field(raw, 'reads')).filter((n): n is number => typeof n === 'number')
  return result
}

export type Table = { columns: string[]; rows: string[][]; truncated: boolean }

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines. Stops after `maxRows` data rows. */
export function parseCsv(text: string, maxRows: number): Table {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  let truncated = false
  const endRecord = () => {
    record.push(field)
    field = ''
    if (!(record.length === 1 && record[0] === '')) records.push(record)
    record = []
  }
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      record.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRecord()
      if (records.length > maxRows) {
        truncated = i + 1 < text.length
        break
      }
    } else field += ch
  }
  if (i >= text.length && (field !== '' || record.length > 0)) endRecord()
  if (records.length > maxRows + 1) {
    records.length = maxRows + 1
    truncated = true
  }
  const [columns = [], ...rows] = records
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

export function parseRunStatus(text: string): RunStatus {
  const status: RunStatus = { failed: {} }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return status
  }
  if (typeof raw !== 'object' || raw === null) return status
  const running: unknown = Reflect.get(raw, 'running')
  if (typeof running === 'object' && running !== null) {
    const number: unknown = Reflect.get(running, 'number')
    const startedAt: unknown = Reflect.get(running, 'startedAt')
    if (typeof number === 'number' && typeof startedAt === 'number') status.running = { number, startedAt }
  }
  const failed: unknown = Reflect.get(raw, 'failed')
  if (typeof failed === 'object' && failed !== null) {
    for (const [key, message] of Object.entries(failed)) {
      if (/^\d+$/.test(key) && typeof message === 'string') status.failed[Number(key)] = message
    }
  }
  const kernel: unknown = Reflect.get(raw, 'kernel')
  if (typeof kernel === 'object' && kernel !== null) {
    const state: unknown = Reflect.get(kernel, 'state')
    const message: unknown = Reflect.get(kernel, 'message')
    if (KERNEL_STATES.includes(state)) {
      status.kernel = { state: state as KernelState, ...(typeof message === 'string' && message !== '' && { message }) }
    }
  }
  return status
}

export type RunHeader = { author: 'user' | 'claude'; from?: number; replay?: number; trusted?: string; engine: Engine }

const SQL_HEADER_LINE = /^-- (?:author: |from: |trusted: |commit: |args: |postgres\s*$)/
const PYTHON_HEADER_LINE = /^# (?:author: |from: |replay: )/

/** The mod's header lines, read from the leading comment lines only (`-- ` for SQL, `# ` for Python). A run with no `author:` line is Claude's. */
export function parseRunHeader(text: string, language: 'sql' | 'python' = 'sql'): RunHeader {
  const header: RunHeader = { author: 'claude', engine: 'databricks' }
  const comment = language === 'python' ? '#' : '--'
  for (const line of text.split('\n')) {
    if (!line.startsWith(comment)) break
    const value = (key: string) => (line.startsWith(`${comment} ${key}: `) ? line.slice(comment.length + key.length + 3).trim() : undefined)
    if (value('author') === 'user') header.author = 'user'
    const from = value('from')
    if (from !== undefined && /^\d+$/.test(from)) header.from = Number(from)
    if (language === 'python') {
      const replay = value('replay')
      if (replay !== undefined && /^\d+$/.test(replay)) header.replay = Number(replay)
      continue
    }
    const trusted = value('trusted')
    if (trusted) header.trusted = trusted.split(/\s/)[0] ?? trusted
    if (/^-- postgres\s*$/.test(line)) header.engine = 'postgres'
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

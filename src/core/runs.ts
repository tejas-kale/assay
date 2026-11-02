// Runs are the files in an analysis's `queries/` folder: `NNN_<slug>.sql` (or `.py`) is the code,
// `NNN_<slug>.csv` the saved result. One number names one run, so the Code and Data tabs link by it.

export type Run = {
  number: number
  /** The zero-padded number as written in the file name, such as `020`. */
  label: string
  slug: string
  /** File names inside `queries/`. */
  code?: string
  data?: string
  language?: 'sql' | 'python'
}

const NAME = /^(\d+)_(.+)\.(sql|py|csv)$/

/** Every run in `queries/`, oldest first. Other files are ignored. */
export function parseRuns(names: readonly string[]): Run[] {
  const runs = new Map<number, Run>()
  for (const name of names) {
    const match = NAME.exec(name)
    if (!match) continue
    const [, label = '', slug = '', ext] = match
    const number = Number(label)
    const run = runs.get(number) ?? { number, label, slug }
    if (ext === 'csv') run.data = name
    else {
      run.code = name
      run.language = ext === 'py' ? 'python' : 'sql'
      run.slug = slug
    }
    runs.set(number, run)
  }
  return [...runs.values()].sort((a, b) => a.number - b.number)
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
export type RunStatus = { running?: { number: number; startedAt: number }; failed: Record<number, string> }

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
  return status
}

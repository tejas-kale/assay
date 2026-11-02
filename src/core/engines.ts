// Where a SQL run goes and how to read what comes back, ported from the analysis mod's hooks/model.ts: the target
// in `.analysis`, the Databricks CLI's JSON and psql's CSV.

export type Table = { columns: string[]; rows: string[][] }
export type Target = { profile: string; warehouse: string; pgDatabase?: string }

export const DEFAULT_TARGET: Target = { profile: 'Cint mkt', warehouse: '455a178462311474' }

/** A Postgres run's .sql starts with this line, so the file says where it ran. */
export const POSTGRES_MARK = '-- postgres'

/** `.analysis` may hold `profile: <name>`, `warehouse: <id>` and `pg_database: <name>` lines. */
export function readTarget(text: string): Target {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'mi').exec(text)?.[1]
  const pgDatabase = value('pg_database')
  return {
    profile: value('profile') ?? DEFAULT_TARGET.profile,
    warehouse: value('warehouse') ?? DEFAULT_TARGET.warehouse,
    ...(pgDatabase ? { pgDatabase } : {}),
  }
}

type CliResult = { columns?: string[]; rows?: string[][]; error?: { message?: string } }

/**
 * Reads `databricks experimental aitools tools query --output json` run on
 * several statements: an array of results, the analysis's query first.
 */
export function parseCliOutput(stdout: string, stderr: string): Table | { error: string } {
  let first: CliResult | undefined
  try {
    const parsed: unknown = JSON.parse(stdout)
    first = Array.isArray(parsed) ? (parsed[0] as CliResult) : undefined
  } catch {
    first = undefined
  }
  if (first?.error) return { error: (first.error.message ?? 'The query failed.').trim() }
  if (first?.columns) return { columns: first.columns, rows: first.rows ?? [] }
  const said = stderr.trim() || stdout.trim()
  return { error: said || 'The Databricks CLI gave no output.' }
}

/** All of a CSV text: quoted cells may hold commas, doubled quotes and newlines. */
function parseCsvAll(text: string): Table {
  const records: string[][] = []
  let record: string[] = []
  let cell = ''
  let isQuoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (isQuoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') isQuoted = false
      else cell += char
    } else if (char === '"') isQuoted = true
    else if (char === ',') {
      record.push(cell)
      cell = ''
    } else if (char === '\n') {
      record.push(cell)
      records.push(record)
      record = []
      cell = ''
    } else if (char !== '\r') cell += char
  }
  if (cell !== '' || record.length > 0) records.push([...record, cell])
  const [columns = [], ...rows] = records
  return { columns, rows }
}

/**
 * Reads `psql --csv -v ON_ERROR_STOP=1`: a header line, then the rows. psql
 * reports an error on stderr as `psql:<file>:<line>: ERROR:  ...` and exits non-zero.
 */
export function parsePsqlOutput(exitCode: number, stdout: string, stderr: string): Table | { error: string } {
  if (exitCode !== 0) {
    const said = stderr.replace(/^psql:[^:\n]*:\d+: /gm, '').trim() || stdout.trim()
    return { error: said || `psql exited with ${exitCode}.` }
  }
  return parseCsvAll(stdout)
}

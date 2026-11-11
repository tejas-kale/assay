// A SQL run: the SQL rules and the included trusted pieces first (`analysis_sql`, docs/slice-9.md and slice-10.md),
// then the statement saved under the next number and run on its engine.
import { ANALYSIS_FILE } from '../core/analyses.ts'
import { parseCliOutput, parsePsqlOutput, POSTGRES_MARK, readTarget } from '../core/engines.ts'
import type { Table, Target } from '../core/engines.ts'
import { queryLabel, runSlug } from '../core/pythonRuns.ts'
import type { Engine } from '../core/runs.ts'
import { QUERIES } from './assay.ts'
import type { Assay, Runner } from './assay.ts'

export const QUERY_TIMEOUT_MS = 600_000
const HELPER_MS = 30_000
/** psql's exit when the shell could not find it. */
const NOT_FOUND = 127
/** Only a launcher brings rds-psql; plain Claude Code has none. */
export const NO_RDS_PSQL = 'Postgres runs need a launcher that provides rds-psql (docs/process/launch-contract.md).'

/** What `python -m analysis_sql lint` prints: rule breaks that stop the query, and warnings that do not. */
export type SqlLint = { errors: string[]; warnings: string[] }
export const SQL_RULES_REJECTED = 'Not run: the query breaks the SQL rules. Fix and send again:'

/** What `python -m analysis_sql expand` prints (docs/slice-10.md, slice 10c). */
export type Expansion = {
  sql: string
  lint_sql: string
  /** The SQL as written with each definition read as TRUE and each block body a plain select: what the retype check reads. */
  retype_sql: string
  built_from: { name: string; kind: string; commit: string }[]
  blocks: { cte: string; name: string }[]
}
export const INCLUDES_REJECTED = 'Not run: the included trusted pieces cannot be used. Fix and send again:'
const RETYPED = 'Retyped trusted logic (include the piece, or add -- retype: <piece>: <why> above the statement):'

/** The run's header line naming what it is built from: `-- built from: name@commit, ...`. */
export function builtFromLine(expansion: Expansion) {
  const pieces = expansion.built_from.map(piece => `${piece.name}@${piece.commit}`)
  return pieces.length === 0 ? '' : `-- built from: ${pieces.join(', ')}\n`
}

/** The reply's line naming what the query is built from. */
export function builtFromReply(expansion: Expansion) {
  const pieces = expansion.built_from.map(piece => `${piece.name} (${piece.kind})`)
  return `Built from: ${pieces.join(', ')}.`
}

/** The expanded SQL's first line: which CTE holds which block, for Steps (`-- blocks: sessions=client_entry_sessions`). */
export function blocksLine(expansion: Expansion) {
  const blocks = expansion.blocks.map(block => `${block.cte}=${block.name}`)
  return blocks.length === 0 ? '' : `-- blocks: ${blocks.join(',')}\n`
}

/** A run's warnings (SQL rules and retypes), beside it in queries/, for the Code tab. */
export const noticesFile = (number: number) => `${QUERIES}/${queryLabel(number)}.notices.json`

/** A run's expanded SQL, beside it in queries/ (never a run: its number is followed by a dot). */
export const expandedFile = (number: number) => `${QUERIES}/${queryLabel(number)}.expanded.sql`

const bullets = (lines: string[]) => lines.map(line => `- ${line}`)
const rejected = (why: string, lines: string[]) => [why, ...bullets(lines)].join('\n')

/** The command that runs a saved query, and how to read what it prints. */
export function queryCommand(engine: Engine, target: Target, file: string) {
  if (engine === 'postgres') {
    // rds-psql (from a launcher, such as the user's sandbox image) signs an IAM token for $PGHOST and opens a read-only session.
    return {
      argv: ['rds-psql', '-X', '--csv', '-v', 'ON_ERROR_STOP=1', ...(target.pgDatabase ? ['-d', target.pgDatabase] : []), '-f', file],
      read: (ran: { exitCode: number; stdout: string; stderr: string }) =>
        ran.exitCode === NOT_FOUND && ran.stderr.includes('ENOENT') ? { error: NO_RDS_PSQL } : parsePsqlOutput(ran.exitCode, ran.stdout, ran.stderr),
    }
  }
  // The trailing `SELECT 1` makes it a multi-query run, whose JSON names the columns even when the query returns no rows.
  return {
    argv: ['databricks', 'experimental', 'aitools', 'tools', 'query', '--profile', target.profile, '--warehouse', target.warehouse, '--output', 'json', '--file', file, 'SELECT 1'],
    read: (ran: { stdout: string; stderr: string }) => parseCliOutput(ran.stdout, ran.stderr),
  }
}

/** Runs a saved .sql file (a path from the analysis) on the engine; its rows, or the error. */
export async function queryFile(assay: Assay, engine: Engine, sqlFile: string): Promise<Table | { error: string }> {
  const command = queryCommand(engine, readTarget(await assay.readText(ANALYSIS_FILE)), sqlFile)
  const ran = await assay.config.proc.run(command.argv, { cwd: assay.config.analysis, timeoutMs: QUERY_TIMEOUT_MS })
  return ran.isStdoutTruncated ? { error: 'The result is over 4 MiB. Aggregate it or add a LIMIT.' } : command.read(ran)
}

/** One SQL run: what `runSql` saves and runs. `expansion` is the caller's, when it already expanded the SQL. */
export type SqlRun = {
  sql: string
  slug: string
  engine: Engine
  /** The run's header lines (who made it, which run it came from). */
  header?: string
  onClaim?: (number: number) => void
  expansion?: Expansion
}

/**
 * Runs SQL as a new run. SQL that includes trusted pieces (`{{ name(...) }}`, docs/slice-10.md) is expanded first:
 * the run keeps the SQL as written under a `-- built from:` line, and the expanded SQL, saved beside it, is what runs.
 * A failed expansion claims no number.
 */
export async function runSql(assay: Assay, request: SqlRun): Promise<string> {
  const { sql, engine } = request
  const expanded = request.expansion ?? (await expandSql(assay, sql, engine))
  if (expanded && 'errors' in expanded) return rejected(INCLUDES_REJECTED, expanded.errors)
  const mark = engine === 'postgres' ? `${POSTGRES_MARK}\n` : ''
  const runner: Runner = {
    slug: runSlug(request.slug),
    saved: `${request.header ?? ''}${expanded ? builtFromLine(expanded) : ''}${mark}${sql.trim()}\n`,
    ...(request.onClaim ? { onClaim: request.onClaim } : {}),
    hasTables: engine === 'databricks',
    run: sqlFile => queryFile(assay, engine, sqlFile),
  }
  if (!expanded) return assay.runQuery(runner)
  return assay.runQuery({
    ...runner,
    preface: expanded.built_from.length > 0 ? builtFromReply(expanded) : undefined,
    dictionaryFile: expandedFile,
    run: async (_sqlFile, number) => {
      await assay.write(expandedFile(number), `${blocksLine(expanded)}${mark}${expanded.sql.trim()}\n`)
      return queryFile(assay, engine, expandedFile(number))
    },
  })
}

const isExpansion = (found: object): found is Expansion =>
  'sql' in found && typeof found.sql === 'string' && 'lint_sql' in found && typeof found.lint_sql === 'string' &&
  'retype_sql' in found && typeof found.retype_sql === 'string' && 'built_from' in found && Array.isArray(found.built_from) &&
  'blocks' in found && Array.isArray(found.blocks)

/** The SQL with its included trusted pieces expanded; undefined when it includes none, `errors` when it cannot be. */
export async function expandSql(assay: Assay, sql: string, engine: Engine): Promise<Expansion | { errors: string[] } | undefined> {
  if (!sql.includes('{{')) return undefined
  const found = await assay.helper<object>(['expand', engine, assay.config.root], HELPER_MS, 'analysis_sql', sql)
  if ('error' in found) return { errors: [`The included pieces could not be expanded: ${found.error}`] }
  if ('errors' in found && Array.isArray(found.errors)) return { errors: found.errors.map(String) }
  if (isExpansion(found)) return found
  return { errors: ['analysis_sql expand printed no expanded SQL'] }
}

/** The SQL rules' verdict on Claude's statement (docs/slice-9.md); undefined for one with no WITH and no JOIN. */
export async function lintSql(assay: Assay, sql: string, engine: Engine): Promise<SqlLint | { error: string } | undefined> {
  if (!/\b(with|join)\b/i.test(sql)) return undefined
  const found = await assay.helper<SqlLint>(['lint', engine], HELPER_MS, 'analysis_sql', sql)
  if ('error' in found) return found
  return Array.isArray(found.errors) && Array.isArray(found.warnings) ? found : { error: 'analysis_sql printed no errors and warnings' }
}

/**
 * The retype check (docs/slice-10.md, slice 10d): SQL that writes out a trusted definition's or block's logic by hand.
 * A check that cannot run says nothing: the lint already reports a missing venv. Postgres is not checked: the
 * dictionary and trusted blocks describe Databricks tables.
 */
export async function retypeWarnings(assay: Assay, sql: string, engine: Engine): Promise<string[]> {
  if (engine === 'postgres') return []
  const found = await assay.helper<{ warnings: string[] }>(['retype', engine, assay.config.root], HELPER_MS, 'analysis_sql', sql)
  return 'warnings' in found && Array.isArray(found.warnings) ? found.warnings.map(String) : []
}

/** Claude's `sql` call: the rules first. A rejected statement claims no number and records no run. */
export async function runClaudeSql(assay: Assay, sql: string, slug: string, engine: Engine): Promise<string> {
  const expansion = await expandSql(assay, sql, engine)
  if (expansion && 'errors' in expansion) return rejected(INCLUDES_REJECTED, expansion.errors)
  // The rules read the SQL as written, each block's body a plain select: its internals were checked in the Trust tab.
  const linted = await lintSql(assay, expansion?.lint_sql ?? sql, engine)
  if (linted && !('error' in linted) && linted.errors.length > 0) return rejected(SQL_RULES_REJECTED, linted.errors)
  const retyped = await retypeWarnings(assay, expansion?.retype_sql ?? sql, engine)
  const claimed: { number?: number } = {}
  const onClaim = (number: number) => {
    claimed.number = number
  }
  const reply = await runSql(assay, { sql, slug, engine, onClaim, ...(expansion ? { expansion } : {}) })
  const rules = linted && !('error' in linted) ? linted.warnings : []
  if (claimed.number !== undefined && (rules.length > 0 || retyped.length > 0)) {
    await assay.writeAtomic(noticesFile(claimed.number), `${JSON.stringify({ rules, retype: retyped })}\n`).catch(() => undefined)
  }
  const parts = [reply]
  // A lint that cannot run does not block: the query ran, and the reply says why it was not checked.
  if (linted && 'error' in linted) parts.push('', `SQL rules not checked: ${linted.error}`)
  if (rules.length > 0) parts.push('', 'SQL rule warnings:', ...bullets(rules))
  if (retyped.length > 0) parts.push('', RETYPED, ...bullets(retyped))
  return parts.join('\n')
}

// Request and reply files: the app asks the mod to run SQL by writing `.assay/requests/<id>.json`
// and reads `.assay/replies/<id>.json` back. The shapes are the contract in specs/slices/slice-2b.md.
import type { Engine, Run, RunHeader } from './runs.ts'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** `<13-digit time>-<6 random [a-z0-9]>`, so file names sort by time. */
export function newRequestId(now: number, random: () => number): string {
  let suffix = ''
  for (let i = 0; i < 6; i++) suffix += ALPHABET.charAt(Math.min(ALPHABET.length - 1, Math.floor(random() * ALPHABET.length)))
  return `${String(now).padStart(13, '0')}-${suffix}`
}

export type SqlRequest = { id: string; sql: string; engine: Engine; from?: number; slug?: string }

/** The request file's text. */
export function sqlRequest({ id, sql, engine, from, slug }: SqlRequest): string {
  if (sql.trim() === '') throw new Error('The SQL is empty')
  return JSON.stringify({ id, kind: 'sql', sql, engine, ...(from !== undefined && { from }), ...(slug !== undefined && { slug }) })
}

export type PythonRequest = { id: string; code: string; from?: number; slug?: string }

/** The request file's text for a Python run; `code` has no header lines (the mod adds them). */
export function pythonRequest({ id, code, from, slug }: PythonRequest): string {
  if (code.trim() === '') throw new Error('The code is empty')
  return JSON.stringify({ id, kind: 'python', code, ...(from !== undefined && { from }), ...(slug !== undefined && { slug }) })
}

export const interruptRequest = (id: string) => JSON.stringify({ id, kind: 'interrupt' })
export const restartRequest = (id: string) => JSON.stringify({ id, kind: 'restart' })

export function replayRequest(id: string, runs: readonly number[]): string {
  if (runs.length === 0) throw new Error('No runs to replay')
  return JSON.stringify({ id, kind: 'replay', runs })
}

/** What the renderer asks main to write: one of the request kinds, without its id. */
export type RunRequest =
  | ({ kind: 'sql' } & Omit<SqlRequest, 'id'>)
  | ({ kind: 'python' } & Omit<PythonRequest, 'id'>)
  | { kind: 'interrupt' }
  | { kind: 'restart' }
  | { kind: 'replay'; runs: number[] }
  | TrustRequest
  | LineageRequest
  | StepsRequest

/** The request file's text for any kind. */
export function requestText(id: string, request: RunRequest): string {
  switch (request.kind) {
    case 'sql':
      return sqlRequest({ id, sql: request.sql, engine: request.engine, ...(request.from !== undefined && { from: request.from }), ...(request.slug !== undefined && { slug: request.slug }) })
    case 'python':
      return pythonRequest({ id, code: request.code, ...(request.from !== undefined && { from: request.from }), ...(request.slug !== undefined && { slug: request.slug }) })
    case 'interrupt':
      return interruptRequest(id)
    case 'restart':
      return restartRequest(id)
    case 'replay':
      return replayRequest(id, request.runs)
    case 'trust-list':
    case 'trust-check':
    case 'trust-done':
      return trustRequestText(id, request)
    case 'lineage':
    case 'steps':
      return JSON.stringify({ id, ...request })
  }
}

export type Reply = { id: string; number: number } | { id: string; ok: true } | { id: string; error: string } | { id: string; proposals: Proposal[] }

export function parseReply(text: string): Reply | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const id: unknown = Reflect.get(raw, 'id')
  if (typeof id !== 'string') return undefined
  const number: unknown = Reflect.get(raw, 'number')
  if (typeof number === 'number') return { id, number }
  const proposals: unknown = Reflect.get(raw, 'proposals')
  if (Array.isArray(proposals)) return { id, proposals: proposals.flatMap(parseProposal) }
  const error: unknown = Reflect.get(raw, 'error')
  if (typeof error === 'string') return { id, error }
  if (Reflect.get(raw, 'ok') === true) return { id, ok: true }
  return undefined
}

function parseProposal(raw: unknown): Proposal[] {
  if (typeof raw !== 'object' || raw === null) return []
  const name: unknown = Reflect.get(raw, 'name')
  const kind: unknown = Reflect.get(raw, 'kind')
  if (typeof name !== 'string' || (kind !== 'calculation' && kind !== 'dictionary')) return []
  return [{ name, kind, folder: kind === 'calculation' ? 'lib/trusted' : 'lib/dictionaries' }]
}

const TRUSTED_PYTHON = "Run a trusted calculation with Claude's trusted tool"

/** Undefined when the run can be re-run (SQL or Python), else the reason it cannot. `body` is the run's `codeBody`. */
export function canRerun(run: Run, header: RunHeader, body?: string): string | undefined {
  if (run.language !== 'python' && header.trusted && body !== undefined && /^-- python:/m.test(body)) return TRUSTED_PYTHON
  return undefined
}

/** A proposal's name: a calculation's or a table's full name (as the server's PROPOSAL_NAME, any case). */
const PROPOSAL = /^[A-Za-z]\w*(\.\w+){0,2}$/

/** The most text a request may carry (1 MiB). */
export const MAX_REQUEST_TEXT = 1 << 20
const MAX_REPLAY_RUNS = 500

/** A run or table number: a non-negative integer below a million. */
export const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000

type Fields = Record<string, unknown>

/** From the renderer, `trust-done` can only say rejected: an approval is main's own report of what it did (main/trustApprove.ts). */
function parseTrustRunRequest(kind: 'trust-check' | 'trust-done', { name, outcome }: Fields): RunRequest | { error: string } {
  if (typeof name !== 'string' || !PROPOSAL.test(name)) return { error: 'Invalid proposal' }
  if (kind === 'trust-check') return { kind, name }
  return outcome === 'rejected' ? { kind, name, outcome } : { error: 'Invalid outcome' }
}

function parseReplayRunRequest({ runs }: Fields): RunRequest | { error: string } {
  if (!Array.isArray(runs) || runs.length === 0 || runs.length > MAX_REPLAY_RUNS || !runs.every(isIndex)) return { error: 'Invalid runs' }
  return { kind: 'replay', runs }
}

/** A `sql` or `python` request: its origin first, then its text (and, for SQL, its engine). */
function parseCodeRunRequest(kind: 'sql' | 'python', { sql, code, engine, from, slug }: Fields): RunRequest | { error: string } {
  if (from !== undefined && !isIndex(from)) return { error: 'Invalid origin' }
  if (slug !== undefined && (typeof slug !== 'string' || slug.length > 200)) return { error: 'Invalid slug' }
  const origin = { ...(from !== undefined && { from }), ...(slug !== undefined && { slug }) }
  if (kind === 'python') {
    if (typeof code !== 'string' || code.length > MAX_REQUEST_TEXT) return { error: 'Invalid code' }
    if (code.trim() === '') return { error: 'The code is empty' }
    return { kind, code, ...origin }
  }
  if (typeof sql !== 'string' || sql.length > MAX_REQUEST_TEXT) return { error: 'Invalid SQL' }
  if (sql.trim() === '') return { error: 'The SQL is empty' }
  if (engine !== 'databricks' && engine !== 'postgres') return { error: 'Invalid engine' }
  return { kind, sql, engine, ...origin }
}

/** Checks what the renderer sent, per kind, and returns the request or the reason it is refused. */
export function parseRunRequest(input: unknown): RunRequest | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'Invalid request' }
  const fields = input as Fields
  const { kind, run } = fields
  if (kind === 'lineage' || kind === 'steps') return isIndex(run) && run > 0 ? { kind, run } : { error: 'Invalid run' }
  if (kind === 'interrupt' || kind === 'restart' || kind === 'trust-list') return { kind }
  if (kind === 'trust-check' || kind === 'trust-done') return parseTrustRunRequest(kind, fields)
  if (kind === 'replay') return parseReplayRunRequest(fields)
  if (kind === 'python' || kind === 'sql') return parseCodeRunRequest(kind, fields)
  return { error: 'Invalid request' }
}

/** The Steps tab asks for run `run`'s lineage (specs/slices/slice-9.md): the server writes `queries/NNN.lineage.json` and replies ok. */
export type LineageRequest = { kind: 'lineage'; run: number }
/** The Steps tab asks for run `run`'s steps to be run, one CTE at a time (slice 9c). Not urgent: it queues with the other runs. */
export type StepsRequest = { kind: 'steps'; run: number }

// ---------------------------------------------------------------------------
// The trust review's requests (specs/slices/slice-5.md): the app lists the proposals, starts a check, and answers one
// that passed. Only the app starts a review, and only the app approves one (IPC `trust:approve`, specs/trust-ledger.md):
// `trust-done` is the app telling the server the review is over, and has no power to promote or trust anything.

export type TrustAnswer = 'trust' | 'reject'
export type TrustOutcome = 'approved' | 'unchanged' | 'rejected'
export type TrustRequest = { kind: 'trust-list' } | { kind: 'trust-check'; name: string } | { kind: 'trust-done'; name: string; outcome: TrustOutcome; message?: string }

/** A proposal in the analysis: a calculation in `lib/trusted/` or a drafted entry in `lib/dictionaries/`. */
export type Proposal = { name: string; kind: 'calculation' | 'dictionary'; folder: 'lib/trusted' | 'lib/dictionaries' }

export function trustRequestText(id: string, request: TrustRequest): string {
  return JSON.stringify({ id, ...request })
}

// ---------------------------------------------------------------------------
// The server's side: a request file as it reads it (ported from the analysis mod's `parseRequest`).

export type ServerRequest =
  | { kind: 'sql'; sql: string; engine: Engine; from?: number; slug: string }
  | { kind: 'python'; code: string; from?: number; slug: string }
  | { kind: 'interrupt' }
  | { kind: 'restart' }
  | { kind: 'replay'; runs: number[] }
  | TrustRequest
  | LineageRequest
  | StepsRequest

/** Interrupt, restart, the trust requests and lineage are taken at once, even while a run is in progress; steps queue like runs. */
export const isUrgent = (request: ServerRequest) => request.kind !== 'sql' && request.kind !== 'python' && request.kind !== 'replay' && request.kind !== 'steps'

const isRunNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

const show = (value: unknown) => String(value)

function parseSqlFile({ sql, engine, from, slug }: Fields): ServerRequest | { error: string } {
  if (typeof sql !== 'string' || !sql.trim()) return { error: 'The SQL is empty.' }
  if (engine !== undefined && engine !== 'databricks' && engine !== 'postgres') return { error: `Unknown engine: ${show(engine)}.` }
  return { kind: 'sql', sql, engine: engine ?? 'databricks', ...(isRunNumber(from) ? { from } : {}), slug: typeof slug === 'string' ? slug : 'query' }
}

function parsePythonFile({ code, from, slug }: Fields): ServerRequest | { error: string } {
  if (typeof code !== 'string' || !code.trim()) return { error: 'The code is empty.' }
  return { kind: 'python', code, ...(isRunNumber(from) ? { from } : {}), slug: typeof slug === 'string' ? slug : 'query' }
}

const MAX_MESSAGE = 500

function parseTrustFile(kind: 'trust-check' | 'trust-done', { name, outcome, message }: Fields): ServerRequest | { error: string } {
  if (typeof name !== 'string' || !name.trim()) return { error: 'Name the proposal.' }
  if (kind === 'trust-check') return { kind, name: name.trim().toLowerCase() }
  if (outcome !== 'approved' && outcome !== 'unchanged' && outcome !== 'rejected') return { error: 'The outcome is approved, unchanged or rejected.' }
  const said = typeof message === 'string' ? message.slice(0, MAX_MESSAGE) : undefined
  return { kind, name: name.trim().toLowerCase(), outcome, ...(said ? { message: said } : {}) }
}

function parseReplayFile({ runs }: Fields): ServerRequest | { error: string } {
  if (!Array.isArray(runs) || runs.length === 0 || !runs.every(isRunNumber)) return { error: 'Name the runs to replay, by number.' }
  return { kind: 'replay', runs }
}

/** A request file's text as a request, or why it is refused. */
export function parseRequestFile(text: string): ServerRequest | { error: string } {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { error: 'The request is not valid JSON.' }
  }
  if (typeof body !== 'object' || body === null) return { error: 'The request is not a JSON object.' }
  const fields = body as Fields
  const { kind, run } = fields
  if (kind === 'sql') return parseSqlFile(fields)
  if (kind === 'python') return parsePythonFile(fields)
  if (kind === 'interrupt' || kind === 'restart' || kind === 'trust-list') return { kind }
  if (kind === 'lineage' || kind === 'steps') return isRunNumber(run) ? { kind, run } : { error: 'Name the run, by number.' }
  if (kind === 'replay') return parseReplayFile(fields)
  if (kind === 'trust-check' || kind === 'trust-done') return parseTrustFile(kind, fields)
  return { error: `Unknown request kind: ${show(kind)}.` }
}

/** The slug a run of selected SQL gets, so its files read `NNN_selection.sql`. */
export const SELECTION_SLUG = 'selection'

/**
 * Cmd+Enter with text selected: the SQL to run as a new run, an error to show, or undefined when nothing is
 * selected (Cmd+Enter then does what it did before). Only SQL can be run from a selection for now.
 */
export function selectedSql(selected: string, language: string | undefined): { sql: string } | { error: string } | undefined {
  if (selected.trim() === '') return undefined
  if (language !== 'sql') return { error: 'Only SQL can be run from a selection.' }
  return { sql: selected.trim() }
}

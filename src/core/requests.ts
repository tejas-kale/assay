// Request and reply files: the app asks the mod to run SQL by writing `.assay/requests/<id>.json`
// and reads `.assay/replies/<id>.json` back. The shapes are the contract in docs/slice-2b.md.
import type { Engine, Run, RunHeader } from './runs.ts'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** `<13-digit time>-<6 random [a-z0-9]>`, so file names sort by time. */
export function newRequestId(now: number, random: () => number): string {
  let suffix = ''
  for (let i = 0; i < 6; i++) suffix += ALPHABET[Math.min(ALPHABET.length - 1, Math.floor(random() * ALPHABET.length))]
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
  }
}

export type Reply = { id: string; number: number } | { id: string; ok: true } | { id: string; error: string }

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
  const error: unknown = Reflect.get(raw, 'error')
  if (typeof error === 'string') return { id, error }
  if (Reflect.get(raw, 'ok') === true) return { id, ok: true }
  return undefined
}

const TRUSTED_PYTHON = "Run a trusted calculation with Claude's trusted tool"

/** Undefined when the run can be re-run (SQL or Python), else the reason it cannot. `body` is the run's `codeBody`. */
export function canRerun(run: Run, header: RunHeader, body?: string): string | undefined {
  if (run.language !== 'python' && header.trusted && body !== undefined && /^-- python:/m.test(body)) return TRUSTED_PYTHON
  return undefined
}

/** The most text a request may carry (1 MiB). */
export const MAX_REQUEST_TEXT = 1 << 20
const MAX_REPLAY_RUNS = 500

/** A run or table number: a non-negative integer below a million. */
export const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000

/** Checks what the renderer sent, per kind, and returns the request or the reason it is refused. */
export function parseRunRequest(input: unknown): RunRequest | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'Invalid request' }
  const { kind, sql, code, engine, from, slug, runs } = input as Record<string, unknown>
  if (kind === 'interrupt' || kind === 'restart') return { kind }
  if (kind === 'replay') {
    if (!Array.isArray(runs) || runs.length === 0 || runs.length > MAX_REPLAY_RUNS || !runs.every(isIndex)) return { error: 'Invalid runs' }
    return { kind, runs: runs as number[] }
  }
  if (kind !== 'python' && kind !== 'sql') return { error: 'Invalid request' }
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

// ---------------------------------------------------------------------------
// The trust review's requests (docs/slice-5.md): the app lists the proposals, starts a check, and answers one
// that passed. Only these start or answer a review: no tool of Claude's can.

export type TrustAnswer = 'trust' | 'reject'
export type TrustRequest = { kind: 'trust-list' } | { kind: 'trust-check'; name: string } | { kind: 'trust-answer'; name: string; answer: TrustAnswer }

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

/** Interrupt, restart and the trust requests are taken at once, even while a run is in progress. */
export const isUrgent = (request: ServerRequest) => request.kind !== 'sql' && request.kind !== 'python' && request.kind !== 'replay'

const isRunNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

/** A request file's text as a request, or why it is refused. */
export function parseRequestFile(text: string): ServerRequest | { error: string } {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { error: 'The request is not valid JSON.' }
  }
  if (typeof body !== 'object' || body === null) return { error: 'The request is not a JSON object.' }
  const { kind, sql, code, engine, from, slug, runs, name, answer } = body as Record<string, unknown>
  const origin = isRunNumber(from) ? { from } : {}
  const slugText = typeof slug === 'string' ? slug : 'query'
  if (kind === 'sql') {
    if (typeof sql !== 'string' || !sql.trim()) return { error: 'The SQL is empty.' }
    if (engine !== undefined && engine !== 'databricks' && engine !== 'postgres') return { error: `Unknown engine: ${String(engine)}.` }
    return { kind, sql, engine: engine ?? 'databricks', ...origin, slug: slugText }
  }
  if (kind === 'python') {
    if (typeof code !== 'string' || !code.trim()) return { error: 'The code is empty.' }
    return { kind, code, ...origin, slug: slugText }
  }
  if (kind === 'interrupt' || kind === 'restart' || kind === 'trust-list') return { kind }
  if (kind === 'replay') {
    if (!Array.isArray(runs) || runs.length === 0 || !runs.every(isRunNumber)) return { error: 'Name the runs to replay, by number.' }
    return { kind, runs }
  }
  if (kind === 'trust-check' || kind === 'trust-answer') {
    if (typeof name !== 'string' || !name.trim()) return { error: 'Name the proposal.' }
    if (kind === 'trust-check') return { kind, name: name.trim().toLowerCase() }
    if (answer !== 'trust' && answer !== 'reject') return { error: 'The answer is trust or reject.' }
    return { kind, name: name.trim().toLowerCase(), answer }
  }
  return { error: `Unknown request kind: ${String(kind)}.` }
}

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

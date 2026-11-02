// Request and reply files: the app asks the mod to run SQL by writing `.assay/requests/<id>.json`
// and reads `.assay/replies/<id>.json` back. The shapes are the contract in docs/slice-2b.md.
import type { Run, RunHeader } from './runs.ts'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** `<13-digit time>-<6 random [a-z0-9]>`, so file names sort by time. */
export function newRequestId(now: number, random: () => number): string {
  let suffix = ''
  for (let i = 0; i < 6; i++) suffix += ALPHABET[Math.min(ALPHABET.length - 1, Math.floor(random() * ALPHABET.length))]
  return `${String(now).padStart(13, '0')}-${suffix}`
}

export type SqlRequest = { id: string; sql: string; engine: 'databricks' | 'postgres'; from?: number; slug?: string }

/** The request file's text. */
export function sqlRequest({ id, sql, engine, from, slug }: SqlRequest): string {
  if (sql.trim() === '') throw new Error('The SQL is empty')
  return JSON.stringify({ id, kind: 'sql', sql, engine, ...(from !== undefined && { from }), ...(slug !== undefined && { slug }) })
}

export type Reply = { id: string; number: number } | { id: string; error: string }

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
  return undefined
}

const PYTHON_LATER = 'Python runs need the kernel (slice 3)'

/** Undefined when the run can be re-run as SQL, else the reason it cannot. `body` is the run's `sqlBody`. */
export function canRerun(run: Run, header: RunHeader, body?: string): string | undefined {
  if (run.language === 'python') return PYTHON_LATER
  if (header.trusted && body !== undefined && /^-- python:/m.test(body)) return PYTHON_LATER
  return undefined
}

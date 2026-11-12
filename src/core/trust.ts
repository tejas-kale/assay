// The trust review the mod writes to `.assay/trust/<name>.json`. Parsed defensively: the file may be
// half-written or from another version, and a bad field must never break the window.

export const TRUST_STATES = ['checking', 'asking', 'approved', 'unchanged', 'rejected', 'failed', 'error'] as const
export type TrustState = (typeof TRUST_STATES)[number]

export type TrustStep = { step: string; ok: boolean; text: string; name?: string; diff?: string }
export type TrustSample = { columns: string[]; rows: string[][]; total?: number }

export type TrustReview = {
  name: string
  kind: 'calculation' | 'dictionary'
  what: string
  language?: 'sql' | 'python' | 'yaml'
  replaces: boolean
  state: TrustState
  startedAt: number
  endedAt?: number
  description?: string
  code?: string
  steps: TrustStep[]
  sample?: TrustSample
  message?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function parseStep(raw: unknown): TrustStep | undefined {
  if (!isRecord(raw)) return undefined
  const step = str(raw['step'])
  if (step === undefined || step === '' || typeof raw['ok'] !== 'boolean') return undefined
  const name = str(raw['name'])
  const diff = str(raw['diff'])
  return { step, ok: raw['ok'], text: str(raw['text']) ?? '', ...(name !== undefined && { name }), ...(diff !== undefined && { diff }) }
}

function parseSample(raw: unknown): TrustSample | undefined {
  if (!isRecord(raw) || !Array.isArray(raw['columns']) || !Array.isArray(raw['rows'])) return undefined
  const rows = raw['rows'].filter(Array.isArray).map(row => row.map(cell => (typeof cell === 'string' ? cell : String(cell ?? ''))))
  const total = raw['total']
  return { columns: strings(raw['columns']), rows, ...(typeof total === 'number' && { total }) }
}

export function parseTrustReview(text: string): TrustReview | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const name = str(raw['name'])
  const state = TRUST_STATES.find(s => s === raw['state'])
  const startedAt = raw['startedAt']
  if (!name || !state || typeof startedAt !== 'number') return undefined
  const language = (['sql', 'python', 'yaml'] as const).find(l => l === raw['language'])
  const sample = parseSample(raw['sample'])
  const endedAt = raw['endedAt']
  const description = str(raw['description'])
  const code = str(raw['code'])
  const message = str(raw['message'])
  return {
    name,
    kind: raw['kind'] === 'dictionary' ? 'dictionary' : 'calculation',
    what: str(raw['what']) ?? '',
    ...(language && { language }),
    replaces: raw['replaces'] === true,
    state,
    startedAt,
    ...(typeof endedAt === 'number' && { endedAt }),
    ...(description !== undefined && { description }),
    ...(code !== undefined && { code }),
    steps: Array.isArray(raw['steps']) ? raw['steps'].flatMap(s => parseStep(s) ?? []) : [],
    ...(sample && { sample }),
    ...(message !== undefined && { message }),
  }
}

/** The review that started last. */
export function latestReview(reviews: readonly TrustReview[]): TrustReview | undefined {
  let best: TrustReview | undefined
  for (const r of reviews) if (!best || r.startedAt > best.startedAt) best = r
  return best
}

/**
 * What the user just answered on `before`, if `after` is that moment: the same review, moved from asking to
 * approved or unchanged (already trusted), or to rejected. The app then tells Claude's session, so the user need
 * not type it.
 */
export function justAnswered(before: TrustReview | undefined, after: TrustReview | undefined): 'trusted' | 'rejected' | undefined {
  if (!before || !after || before.startedAt !== after.startedAt || before.name !== after.name) return undefined
  if (before.state !== 'asking') return undefined
  if (after.state === 'approved' || after.state === 'unchanged') return 'trusted'
  if (after.state === 'rejected') return 'rejected'
  return undefined
}

/**
 * Whether `after` is a check that just failed or broke: it ended `failed` or `error` and the window last saw it
 * still running, or saw an earlier review. `before` is null when the window saw no review, undefined before its
 * first look (then nothing is news: the failure may be old).
 */
export function justFailed(before: TrustReview | null | undefined, after: TrustReview | undefined): boolean {
  if (before === undefined || !after || (after.state !== 'failed' && after.state !== 'error')) return false
  return before === null || before.startedAt !== after.startedAt || isActive(before.state)
}

const MAX_FAILURE = 700
const isControl = (char: string) => {
  const code = char.charCodeAt(0)
  return code <= 0x1f || code === 0x7f
}
const oneLine = (text: string) => Array.from(text, char => (isControl(char) ? ' ' : char)).join('').replace(/\s+/g, ' ').trim()

/**
 * What the app types into Claude's session when a check failed: the failed steps in one line, where the whole
 * review is, and what to do. One line, so it cannot submit early; Claude reads the file for the full trace.
 */
export function failedMessage(review: TrustReview): string {
  const failed = review.steps.filter(step => !step.ok).map(step => `${stepTitle(step)}: ${stepDetail(step)}`)
  const what = failed.length ? failed.join('; ') : (review.message ?? review.state)
  let detail = oneLine(what)
  if (detail.length > MAX_FAILURE) detail = `${detail.slice(0, MAX_FAILURE)}…`
  const verb = review.state === 'error' ? 'broke' : 'failed'
  return (
    `The Trust tab check of ${review.name} ${verb}: ${detail}. The full review, with each step's output and diff, ` +
    `is in .assay/trust/${review.name}.json. Fix the draft, then tell me to press Check again.\r`
  )
}

/** `test case 2`, `transpile`. Only a test step shows its name. */
export function stepTitle(step: TrustStep): string {
  return step.step === 'test' && step.name ? `${step.step} ${step.name}` : step.step
}

/** What the Trust tab's "new since you looked" marker compares: changes when the review moves on. */
export const trustSeenKey = (review: TrustReview): string =>
  `${String(review.startedAt)}:${review.state}:${String(review.steps.length)}:${String(review.sample?.rows.length ?? 0)}`

/** A step's text without a leading PASSED or FAILED (the line shows that as its marker). */
export function stepDetail(step: TrustStep): string {
  return step.text.replace(/^(PASSED|FAILED)\s*/, '')
}

/** A review still in progress: checks running or the question open. */
export const isActive = (state: TrustState): boolean => state === 'checking' || state === 'asking'

export type Tone = 'good' | 'warn' | 'bad' | 'dim'

export function stateTone(state: TrustState): Tone {
  if (state === 'approved' || state === 'unchanged') return 'good'
  if (state === 'rejected' || state === 'failed') return 'warn'
  if (state === 'error') return 'bad'
  return 'dim'
}

export type DiffLine = { kind: 'add' | 'del' | 'same'; text: string }

/** A step's diff: `- ` lines were expected only, `+ ` lines were got only. */
export function diffLines(diff: string): DiffLine[] {
  return diff.split('\n').map(text => ({ kind: diffKind(text), text }))
}

function diffKind(text: string): DiffLine['kind'] {
  if (text.startsWith('+ ')) return 'add'
  return text.startsWith('- ') ? 'del' : 'same'
}

/** The state line: the ticking count while checking, a pointer while asking, else the message. */
export function stateLine(review: TrustReview, now: number): { text: string; tone: Tone } {
  if (review.state === 'checking') return { text: `checking… ${String(Math.max(0, Math.round((now - review.startedAt) / 1000)))} s`, tone: 'dim' }
  if (review.state === 'asking') return { text: 'Every check passed: Trust (t) or Reject (r).', tone: 'dim' }
  return { text: review.message ?? review.state, tone: stateTone(review.state) }
}

/**
 * A settled review whose name is no longer among the proposals: an earlier one (trusted, rejected or failed),
 * so the Trust tab says so instead of showing it as the one to act on. False until the list is known.
 */
export function earlierReview(review: TrustReview | undefined, proposals: readonly { name: string }[] | undefined): boolean {
  if (!review || !proposals || isActive(review.state)) return false
  return !proposals.some(p => p.name === review.name)
}

/** What became of a settled review, in words. */
export function outcomeWord(state: TrustState): string {
  const words: Record<TrustState, string> = {
    checking: 'checking',
    asking: 'waiting for an answer',
    approved: 'trusted',
    unchanged: 'already trusted, unchanged',
    rejected: 'rejected',
    failed: 'failed its checks',
    error: 'stopped with an error',
  }
  return words[state]
}

/** Whether the Trust tab offers Trust and Reject for this review: only once every check passed. */
export const canAnswer = (review: TrustReview | undefined): boolean => review?.state === 'asking'

/** Whether the Trust tab offers Check: no review of any name is checking or waiting for its answer. */
export const canCheck = (review: TrustReview | undefined): boolean => !review || !isActive(review.state)

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

/** `test case 2`, `transpile`. Only a test step shows its name. */
export function stepTitle(step: TrustStep): string {
  return step.step === 'test' && step.name ? `${step.step} ${step.name}` : step.step
}

/** What the Trust tab's "new since you looked" marker compares: changes when the review moves on. */
export const trustSeenKey = (review: TrustReview): string =>
  `${review.startedAt}:${review.state}:${review.steps.length}:${review.sample?.rows.length ?? 0}`

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
  return diff.split('\n').map(text => ({ kind: text.startsWith('+ ') ? 'add' : text.startsWith('- ') ? 'del' : 'same', text }))
}

/** The state line: the ticking count while checking, a pointer while asking, else the message. */
export function stateLine(review: TrustReview, now: number): { text: string; tone: Tone } {
  if (review.state === 'checking') return { text: `checking… ${Math.max(0, Math.round((now - review.startedAt) / 1000))} s`, tone: 'dim' }
  if (review.state === 'asking') return { text: 'Answer in the Claude pane (⌘1)', tone: 'dim' }
  return { text: review.message ?? review.state, tone: stateTone(review.state) }
}

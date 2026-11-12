// A run's steps (specs/slices/slice-9.md, slice 9c): the plan `python -m analysis_sql steps` makes, run one CTE at a time by the
// server and saved next to the run as `queries/NNN.steps.json`. Pure: parsing that file, the grain and join checks on
// the counts each step returned, and the marks that colour the diagram.
import type { Cardinality, LineageMark } from './lineage.ts'
import { queryLabel } from './pythonRuns.ts'

/** A join in a step's SELECT. `checked: false` means its counts were not asked for; `reason` says why. */
export type PlannedJoin = { j: number; source: string; declared?: Cardinality; keys?: string[]; checked?: boolean; reason?: string }
export type StepStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped'
/** `unchecked` lines are the dim reasons a join was not counted; they are never failures. */
export type StepCheck = { kind: 'grain' | 'join' | 'unchecked'; ok: boolean; text: string }
export type Step = {
  k: number
  name: string
  /** Index in the lineage's nodes. */
  node: number
  status: StepStatus
  error?: string
  rows?: number
  counts?: Record<string, string>
  checks?: StepCheck[]
  /** The columns of the `-- grain:` line, `[]` for `none`; absent with no line. */
  grain?: string[]
  joins?: PlannedJoin[]
  /** The trusted block this step's CTE includes (specs/slices/slice-10.md): one step, its joins checked once in the Trust tab. */
  block?: string
}
export type StepsFile = { run: number; status: 'running' | 'done' | 'error'; note?: string; steps: Step[] }

const STATUSES = ['pending', 'running', 'ok', 'error', 'skipped']
const CARDINALITIES = ['1:1', '1:many', 'many:1', 'many:many']
const CHECK_KINDS = ['grain', 'join', 'unchecked']

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null && !Array.isArray(v)
const field = (v: object, key: string): unknown => Reflect.get(v, key)
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === 'string') : [])
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function parseJoin(raw: unknown): PlannedJoin[] {
  if (!isObject(raw)) return []
  const j = field(raw, 'j')
  const source = field(raw, 'source')
  if (!isCount(j) || typeof source !== 'string') return []
  const declared = field(raw, 'declared')
  const reason = field(raw, 'reason')
  return [
    {
      j,
      source,
      ...(typeof declared === 'string' && CARDINALITIES.includes(declared) && { declared: declared as Cardinality, keys: strings(field(raw, 'keys')) }),
      ...(field(raw, 'checked') === false && { checked: false }),
      ...(typeof reason === 'string' && { reason }),
    },
  ]
}

function parseCheck(raw: unknown): StepCheck[] {
  if (!isObject(raw)) return []
  const kind = field(raw, 'kind')
  const ok = field(raw, 'ok')
  const text = field(raw, 'text')
  if (typeof kind !== 'string' || !CHECK_KINDS.includes(kind) || typeof ok !== 'boolean' || typeof text !== 'string') return []
  return [{ kind: kind as StepCheck['kind'], ok, text }]
}

function parseStep(raw: unknown): Step[] {
  if (!isObject(raw)) return []
  const k = field(raw, 'k')
  const name = field(raw, 'name')
  const node = field(raw, 'node')
  const status = field(raw, 'status')
  if (!isCount(k) || k < 1 || typeof name !== 'string' || !isCount(node) || typeof status !== 'string' || !STATUSES.includes(status)) return []
  const error = field(raw, 'error')
  const rows = field(raw, 'rows')
  const counts = field(raw, 'counts')
  const checks = field(raw, 'checks')
  const grain = field(raw, 'grain')
  const joins = field(raw, 'joins')
  const block = field(raw, 'block')
  return [
    {
      k,
      name,
      node,
      status: status as StepStatus,
      ...(typeof error === 'string' && { error }),
      ...(isCount(rows) && { rows }),
      ...(isObject(counts) && { counts: Object.fromEntries(Object.entries(counts).filter((e): e is [string, string] => typeof e[1] === 'string')) }),
      ...(Array.isArray(checks) && { checks: (checks as unknown[]).flatMap(parseCheck) }),
      ...(Array.isArray(grain) && { grain: strings(grain) }),
      ...(Array.isArray(joins) && { joins: (joins as unknown[]).flatMap(parseJoin) }),
      ...(typeof block === 'string' && block && { block }),
    },
  ]
}

/** Reads `NNN.steps.json` safely: malformed steps are dropped; undefined when it is not a steps file. */
export function parseSteps(text: string): StepsFile | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw)) return undefined
  const run = field(raw, 'run')
  const status = field(raw, 'status')
  const steps = field(raw, 'steps')
  if (!isCount(run) || (status !== 'running' && status !== 'done' && status !== 'error') || !Array.isArray(steps)) return undefined
  const note = field(raw, 'note')
  return { run, status, ...(typeof note === 'string' && { note }), steps: (steps as unknown[]).flatMap(parseStep) }
}

/** A step's name as it appears in file names: the same rule the kernel's `q(N, step=name)` applies. */
export const stepSlug = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

/** The files of one step in `queries/`. */
export type StepFile = { k: number; name: string; sql?: string; csv?: string; counts?: string }

/** Run `number`'s step files among `names` (`queries/`'s listing), by k: `NNN.k_name.sql`, `.csv` and `.counts.sql`. */
export function stepFiles(names: readonly string[], number: number): StepFile[] {
  const prefix = `${queryLabel(number)}.`
  const found = new Map<number, StepFile>()
  for (const file of names) {
    const match = file.startsWith(prefix) ? /^(\d+)_([^.]+)(\.counts)?\.(sql|csv)$/.exec(file.slice(prefix.length)) : null
    if (!match?.[1] || !match[2] || (match[3] && match[4] === 'csv')) continue
    const k = Number(match[1])
    const step = found.get(k) ?? { k, name: match[2] }
    if (match[3]) step.counts = file
    else if (match[4] === 'csv') step.csv = file
    else step.sql = file
    found.set(k, step)
  }
  return [...found.values()].sort((a, b) => a.k - b.k)
}

/** How many steps History shows for a run: those planned in its `NNN.steps.json` when there is one, else those with a `.csv`. */
export const countSteps = (names: readonly string[], number: number, file?: StepsFile): number => (file ? file.steps.length : stepFiles(names, number).filter(step => step.csv !== undefined).length)

const num = (counts: Readonly<Record<string, string>>, key: string): number | undefined => {
  const value = counts[key]
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`

function grainCheck(step: Pick<Step, 'grain'>, counts: Readonly<Record<string, string>>): StepCheck[] {
  const rows = num(counts, 'assay_rows')
  if (step.grain === undefined || rows === undefined) return []
  if (step.grain.length === 0) {
    return [rows === 1 ? { kind: 'grain', ok: true, text: 'grain none (one row): 1 row' } : { kind: 'grain', ok: false, text: `grain none (one row) has ${plural(rows, 'row')}` }]
  }
  const distinct = num(counts, 'assay_grain_rows')
  if (distinct === undefined) return []
  const grain = step.grain.join(', ')
  return [rows === distinct ? { kind: 'grain', ok: true, text: `grain ${grain}: ${plural(rows, 'row')}, ${String(distinct)} distinct` } : { kind: 'grain', ok: false, text: `grain ${grain} has ${plural(rows - distinct, 'duplicate row')}` }]
}

function joinChecks(join: PlannedJoin, counts: Readonly<Record<string, string>>): StepCheck[] {
  const { declared } = join
  if (join.checked === false || declared === undefined) return []
  const read = (side: 'left' | 'right') => {
    const rows = num(counts, `assay_j${String(join.j)}_${side}_rows`)
    const keys = num(counts, `assay_j${String(join.j)}_${side}_keys`)
    return rows === undefined || keys === undefined ? undefined : { rows, keys }
  }
  const left = read('left')
  const right = read('right')
  if (!left || !right) return []
  const [declaredLeft, declaredRight] = declared.split(':')
  const keyNames = (join.keys ?? []).join(', ')
  const sides = [
    { name: 'left', declared: declaredLeft, seen: left },
    { name: 'right', declared: declaredRight, seen: right },
  ]
  const wrong = sides.filter(side => side.declared === '1' && side.seen.rows !== side.seen.keys)
  if (wrong.length > 0) {
    return wrong.map(side => ({
      kind: 'join',
      ok: false,
      text: `join ${join.source} declared ${declared} but the ${side.name} side repeats ${keyNames} (${String(side.seen.rows)} rows, ${String(side.seen.keys)} keys)`,
    }))
  }
  const observed = sides.map(side => (side.seen.rows === side.seen.keys ? '1' : 'many')).join(':')
  const note = observed === declared ? '' : ` (observed ${observed})`
  return [{ kind: 'join', ok: true, text: `join ${join.source} ${declared} on ${keyNames}: left ${String(left.rows)} rows, ${String(left.keys)} keys; right ${String(right.rows)} rows, ${String(right.keys)} keys${note}` }]
}

/** The grain and join checks of a step, from the one row its counts query returned. Joins not counted give none. */
export function stepChecks(step: Pick<Step, 'grain' | 'joins'>, counts: Readonly<Record<string, string>>): StepCheck[] {
  return [...grainCheck(step, counts), ...(step.joins ?? []).flatMap(join => joinChecks(join, counts))]
}

/** The dim lines for joins that were not counted, and why. */
export const uncheckedLines = (step: Pick<Step, 'joins'>): StepCheck[] =>
  (step.joins ?? []).flatMap(join => (join.checked === false ? [{ kind: 'unchecked' as const, ok: true, text: `join ${join.source} not checked: ${join.reason ?? 'no reason given'}` }] : []))

/** How a step colours its node: a failed check or an error is `bad`; a pending step has no mark. */
export function stepMark(step: Pick<Step, 'status' | 'checks'>): LineageMark | undefined {
  switch (step.status) {
    case 'pending':
      return undefined
    case 'running':
      return 'running'
    case 'skipped':
      return 'skipped'
    case 'error':
      return 'bad'
    case 'ok':
      return step.checks?.some(check => !check.ok) ? 'bad' : 'ok'
  }
}

/** `marks` for `lineageMermaid`, by node index. */
export function stepMarks(steps: readonly Step[]): Record<number, LineageMark> {
  const marks: Record<number, LineageMark> = {}
  for (const step of steps) {
    const mark = stepMark(step)
    if (mark) marks[step.node] = mark
  }
  return marks
}

/** The step to select after moving `delta` from `k` (1-based): clamped to the steps there are. */
export function moveStep(k: number, delta: 1 | -1, count: number): number {
  return Math.min(Math.max(k + delta, 1), Math.max(count, 1))
}

/** `running step 2 of 4` while a step runs; undefined otherwise. */
export function runningLabel(file: StepsFile | undefined): string | undefined {
  const running = file?.steps.find(step => step.status === 'running')
  return running ? `running step ${String(running.k)} of ${String(file?.steps.length ?? 0)}` : undefined
}

/** One line for a ✗ check, as `.assay/step-notices.json` carries it: `q042 step spend_per_customer: grain ... has 3 duplicate rows.` */
export const stepNoticeLine = (number: number, step: Pick<Step, 'name'>, check: Pick<StepCheck, 'text'>) => `q${queryLabel(number)} step ${step.name}: ${check.text}.`

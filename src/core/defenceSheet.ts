// The delegated-analysis defence sheet (specs/delegated-runs.md): comparing the latest answer and reconciliation
// spec runs against the frozen preface, surfacing the four SQL review flags, and formatting `defence-sheet.md`.
import type { SqlCoverage } from './coverage.ts'
import type { FrozenPreface } from './preface.ts'
import { queryLabel } from './pythonRuns.ts'
import { parseCsv, parseRunHeader } from './runs.ts'
import type { RunHeader } from './runs.ts'
import type { Step, StepsFile } from './steps.ts'

export const DEFENCE_SHEET_FILE = 'defence-sheet.md'
export const DECISIONS_FILE = 'decisions.md'

export type RunNotices = { rules: string[]; retype: string[] }
export type DecisionEntry = { decision: string; defaultTaken: string; why: string; run?: number }
export type DefenceRunInput = { number: number; slug: string; code: string; csv?: string; steps?: StepsFile; notices?: RunNotices }
export type DefenceSheetInput = {
  preface: FrozenPreface
  coverage?: SqlCoverage
  runs: readonly DefenceRunInput[]
  decisions?: readonly DecisionEntry[]
}

export type AnnotatedSpecRun = {
  number: number
  slug: string
  code: string
  header: RunHeader
  actual: number | null
  builtFrom: string[]
  timeWindows: string[]
  steps: Step[]
  retypeWarnings: string[]
}

export type AnswerCheck = {
  specId: string
  low: number
  high: number
  latestRun: AnnotatedSpecRun | undefined
  earlierRuns: AnnotatedSpecRun[]
  actual: number | null
  inRange: boolean
}

export type ReconciliationCheck = {
  specId: string
  knownTotal: number | undefined
  tolerance: number
  status: 'passed' | 'failed' | 'omitted'
  latestRun: AnnotatedSpecRun | undefined
  earlierRuns: AnnotatedSpecRun[]
  actual: number | null
  diff: number | null
}

export type SpecSection = {
  id: string
  text: string
  frozen: boolean
  latestRun: AnnotatedSpecRun | undefined
  earlierRuns: AnnotatedSpecRun[]
  builtFrom: string[]
  timeWindows: string[]
  steps: Step[]
}

export type DefenceFlags = { range: boolean; reconciliation: boolean; retype: boolean; decisions: boolean; anyFlagged: boolean }
export type DefenceSheet = {
  preface: FrozenPreface
  coverage: SqlCoverage | undefined
  flags: DefenceFlags
  answer: AnswerCheck
  reconciliation: ReconciliationCheck
  specs: SpecSection[]
  retypeWarnings: string[]
  decisions: DecisionEntry[]
}

const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g
const RUN_CITE_SUFFIX = /\(\[q\s*(\d+)\]\)$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : [])

/** Parses `NNN.notices.json` safely; returns empty arrays when missing or malformed. */
export function parseNotices(text: string): RunNotices {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { rules: [], retype: [] }
  }
  if (!isObject(raw)) return { rules: [], retype: [] }
  return { rules: stringList(raw.rules), retype: stringList(raw.retype) }
}

function parseDecisionLine(rawLine: string): DecisionEntry | undefined {
  const line = rawLine.trim()
  if (!line.startsWith('- **') && !line.startsWith('* **')) return undefined
  const afterBullet = line.slice(4)
  const closeBold = afterBullet.indexOf('**:')
  if (closeBold <= 0) return undefined
  const decision = afterBullet.slice(0, closeBold).trim()
  const rest = afterBullet.slice(closeBold + 3).trim()
  const hasEmDash = rest.includes(' — ')
  const sepIndex = hasEmDash ? rest.indexOf(' — ') : rest.indexOf(' -- ')
  if (sepIndex <= 0) return undefined
  const defaultTaken = rest.slice(0, sepIndex).trim()
  let why = rest.slice(sepIndex + (hasEmDash ? 3 : 4)).trim()
  const citeMatch = RUN_CITE_SUFFIX.exec(why)
  const run = citeMatch ? Number(citeMatch[1]) : undefined
  if (citeMatch) why = why.slice(0, citeMatch.index).trim()
  return why ? { decision, defaultTaken, why, ...(run ? { run } : {}) } : undefined
}

/** Parses `decisions.md` bullets (`- **<decision>**: <default> — <why> ([q NNN])`) into `DecisionEntry` items. */
export function parseDecisions(text: string): DecisionEntry[] {
  return text.split('\n').flatMap(line => {
    const parsed = parseDecisionLine(line)
    return parsed ? [parsed] : []
  })
}

/** Distinct YYYY-MM-DD dates found in SQL text or spec prose, in order of appearance. */
export function extractDateWindows(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(DATE_PATTERN)) seen.add(match[0])
  return [...seen]
}

function extractScalarValue(csv: string | undefined): number | null {
  if (!csv) return null
  const firstRow = parseCsv(csv, 5).rows[0] ?? []
  let found: number | null = null
  for (const cell of firstRow) {
    const trimmed = cell.trim()
    if (trimmed === '') continue
    const num = Number(trimmed)
    if (Number.isFinite(num)) found = num
  }
  return found
}

function annotateRun(run: DefenceRunInput): AnnotatedSpecRun {
  const header = parseRunHeader(run.code, 'sql')
  return {
    number: run.number,
    slug: run.slug,
    code: run.code,
    header,
    actual: extractScalarValue(run.csv),
    builtFrom: header.builtFrom ?? [],
    timeWindows: extractDateWindows(run.code),
    steps: run.steps?.steps ?? [],
    retypeWarnings: run.notices?.retype ?? [],
  }
}

function groupRunsBySpec(runs: readonly DefenceRunInput[], prefaceId: string): Map<string, AnnotatedSpecRun[]> {
  const bySpec = new Map<string, AnnotatedSpecRun[]>()
  for (const raw of [...runs].sort((a, b) => a.number - b.number)) {
    const annotated = annotateRun(raw)
    const { spec, preface } = annotated.header
    if (!spec || (preface !== undefined && preface !== prefaceId)) continue
    const list = bySpec.get(spec) ?? []
    list.push(annotated)
    bySpec.set(spec, list)
  }
  return bySpec
}

function splitLatest(runs: readonly AnnotatedSpecRun[]): { latestRun: AnnotatedSpecRun | undefined; earlierRuns: AnnotatedSpecRun[] } {
  return { latestRun: runs[runs.length - 1], earlierRuns: runs.slice(0, -1) }
}

function evaluateAnswer(preface: FrozenPreface, runs: readonly AnnotatedSpecRun[]): AnswerCheck {
  const { latestRun, earlierRuns } = splitLatest(runs)
  const actual = latestRun?.actual ?? null
  const inRange =
    latestRun !== undefined && latestRun.header.specFrozen !== false && actual !== null && actual >= preface.low && actual <= preface.high
  return { specId: preface.answer, low: preface.low, high: preface.high, latestRun, earlierRuns, actual, inRange }
}

function evaluateReconciliation(preface: FrozenPreface, runs: readonly AnnotatedSpecRun[]): ReconciliationCheck {
  const { latestRun, earlierRuns } = splitLatest(runs)
  const actual = latestRun?.actual ?? null
  const tolerance = preface.tolerance ?? 0
  if (preface.known_total === undefined) {
    const status = latestRun?.header.specFrozen === false ? 'failed' : 'omitted'
    return { specId: preface.reconciliation, knownTotal: undefined, tolerance, status, latestRun, earlierRuns, actual, diff: null }
  }
  const diff = actual === null ? null : Math.abs(actual - preface.known_total)
  const passed = latestRun !== undefined && latestRun.header.specFrozen !== false && diff !== null && diff <= tolerance
  return {
    specId: preface.reconciliation,
    knownTotal: preface.known_total,
    tolerance,
    status: passed ? 'passed' : 'failed',
    latestRun,
    earlierRuns,
    actual,
    diff,
  }
}

function buildSpecSections(preface: FrozenPreface, bySpec: Map<string, AnnotatedSpecRun[]>): SpecSection[] {
  const sections: SpecSection[] = []
  const frozenIds = new Set<string>()
  for (const spec of preface.specs) {
    frozenIds.add(spec.id)
    const { latestRun, earlierRuns } = splitLatest(bySpec.get(spec.id) ?? [])
    sections.push({
      id: spec.id,
      text: spec.text,
      frozen: latestRun?.header.specFrozen !== false,
      latestRun,
      earlierRuns,
      builtFrom: latestRun?.builtFrom ?? [],
      timeWindows: extractDateWindows(`${spec.text}\n${latestRun?.code ?? ''}`),
      steps: latestRun?.steps ?? [],
    })
  }
  for (const [id, runs] of bySpec) {
    if (frozenIds.has(id)) continue
    const { latestRun, earlierRuns } = splitLatest(runs)
    sections.push({
      id,
      text: '(unfrozen spec — not in .assay/preface.json)',
      frozen: false,
      latestRun,
      earlierRuns,
      builtFrom: latestRun?.builtFrom ?? [],
      timeWindows: latestRun?.timeWindows ?? [],
      steps: latestRun?.steps ?? [],
    })
  }
  return sections
}

function collectRetypeWarnings(bySpec: Map<string, AnnotatedSpecRun[]>): string[] {
  const warnings: string[] = []
  for (const [spec, runs] of bySpec) {
    for (const run of runs) {
      const label = `q${queryLabel(run.number)}`
      if (run.header.specFrozen === false) warnings.push(`${label}: spec "${spec}" was not frozen in .assay/preface.json`)
      for (const warning of run.retypeWarnings) warnings.push(`${label}: ${warning}`)
    }
  }
  return warnings
}

/** Builds the structured defence sheet from the frozen preface, coverage, runs, and decision log. */
export function buildDefenceSheet(input: DefenceSheetInput): DefenceSheet {
  const { preface, coverage } = input
  const decisions = [...(input.decisions ?? [])]
  const bySpec = groupRunsBySpec(input.runs, preface.id)
  const answer = evaluateAnswer(preface, bySpec.get(preface.answer) ?? [])
  const reconciliation = evaluateReconciliation(preface, bySpec.get(preface.reconciliation) ?? [])
  const specs = buildSpecSections(preface, bySpec)
  const retypeWarnings = collectRetypeWarnings(bySpec)
  const range = !answer.inRange
  const reconFlag = reconciliation.status === 'failed'
  const retype = retypeWarnings.length > 0
  const decisionsFlag = decisions.length > 0
  return {
    preface,
    coverage,
    flags: { range, reconciliation: reconFlag, retype, decisions: decisionsFlag, anyFlagged: range || reconFlag || retype || decisionsFlag },
    answer,
    reconciliation,
    specs,
    retypeWarnings,
    decisions,
  }
}

const citeRun = (run: AnnotatedSpecRun | undefined): string => (run ? `[q ${queryLabel(run.number)}]` : 'no run')
const flagLabel = (flagged: boolean) => (flagged ? 'FLAG' : 'OK')

function renderFlagsSection(sheet: DefenceSheet): string[] {
  const { flags, answer, reconciliation, retypeWarnings, decisions } = sheet
  const reconDetail =
    reconciliation.status === 'omitted'
      ? 'known_total omitted (optimisation task)'
      : `actual ${String(reconciliation.actual ?? 'missing')} (${citeRun(reconciliation.latestRun)}) vs ${String(reconciliation.knownTotal)} ± ${String(reconciliation.tolerance)}`
  return [
    '## Review Flags',
    `- **Range (${flagLabel(flags.range)})**: actual ${String(answer.actual ?? 'missing')} (${citeRun(answer.latestRun)}) vs [${String(answer.low)}, ${String(answer.high)}]`,
    `- **Reconciliation (${flagLabel(flags.reconciliation)})**: ${reconDetail}`,
    `- **Retype & Unfrozen Spec Warnings (${flagLabel(flags.retype)})**: ${String(retypeWarnings.length)} stored`,
    `- **Logged Decisions (${flagLabel(flags.decisions)})**: ${String(decisions.length)} logged`,
  ]
}

function renderCoverageSection(sheet: DefenceSheet): string[] {
  const { coverage } = sheet
  const share =
    coverage?.coverage !== undefined && coverage.coverage !== null
      ? `${String(Math.round(coverage.coverage * 100))}% (${String(coverage.trustedTokens)} / ${String(coverage.totalTokens)} tokens)`
      : 'no SQL tokens recorded'
  return ['## Trusted-SQL Coverage', `- **Analysis coverage**: ${share}`]
}

function formatStepLine(step: Step): string {
  const blockTag = step.block ? ` (block ${step.block})` : ''
  const rowsText = step.rows === undefined ? step.status : `${String(step.rows)} rows`
  const failedChecks = (step.checks ?? []).filter(c => !c.ok).map(c => c.text)
  const checkSuffix = failedChecks.length > 0 ? ` — FAILED: ${failedChecks.join('; ')}` : ''
  return `  - ${step.name}${blockTag}: ${rowsText}${checkSuffix}`
}

function renderSpecSection(spec: SpecSection): string[] {
  const earlier = spec.earlierRuns.length > 0 ? spec.earlierRuns.map(r => `[q ${queryLabel(r.number)}]`).join(', ') : 'none'
  const built = spec.builtFrom.length > 0 ? spec.builtFrom.join(', ') : 'none'
  const windows = spec.timeWindows.length > 0 ? spec.timeWindows.join(', ') : 'none'
  const stepsLines = spec.steps.length === 0 ? ['- **Steps**: none recorded'] : ['- **Steps**:', ...spec.steps.map(formatStepLine)]
  return [
    `### Spec \`${spec.id}\`${spec.frozen ? '' : ' (UNFROZEN)'}`,
    `- **Approved spec**: ${spec.text}`,
    `- **Latest run**: ${citeRun(spec.latestRun)}`,
    `- **Earlier runs**: ${earlier}`,
    `- **Built from**: ${built}`,
    `- **Time windows**: ${windows}`,
    ...stepsLines,
  ]
}

function formatDecisionLine(d: DecisionEntry): string {
  const cite = d.run === undefined ? '' : ` ([q ${queryLabel(d.run)}])`
  return `- **${d.decision}**: ${d.defaultTaken} — ${d.why}${cite}`
}

function renderRetypeAndDecisions(sheet: DefenceSheet): string[] {
  const retypeLines = sheet.retypeWarnings.length === 0 ? ['- None.'] : sheet.retypeWarnings.map(w => `- ${w}`)
  const decisionLines = sheet.decisions.length === 0 ? ['- None.'] : sheet.decisions.map(formatDecisionLine)
  return [
    '## Stored Retype & Spec Warnings',
    ...retypeLines,
    '',
    '## Falsifiers',
    ...sheet.preface.falsifiers.map(f => `- ${f}`),
    '',
    '## Decision Log',
    ...decisionLines,
  ]
}

/** Renders the structured defence sheet as Markdown (`defence-sheet.md`). */
export function renderDefenceSheet(sheet: DefenceSheet): string {
  const verdict = sheet.flags.anyFlagged
    ? 'SQL review required: one or more flags triggered.'
    : 'All checks passed: no SQL review flags triggered.'
  return [
    '# Defence Sheet',
    '',
    `- **Frozen preface**: \`${sheet.preface.id}\` (${sheet.preface.frozenAt})`,
    `- **Status**: ${verdict}`,
    '',
    ...renderFlagsSection(sheet),
    '',
    ...renderCoverageSection(sheet),
    '',
    '## Specs, Runs & Step Counts',
    ...sheet.specs.flatMap(spec => ['', ...renderSpecSection(spec)]).slice(1),
    '',
    ...renderRetypeAndDecisions(sheet),
    '',
  ].join('\n')
}

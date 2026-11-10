// The ratchet (docs/process/testing.md): two baselines that may only shrink.
// - python/ruff-baseline.json: ruff's violation counts per file and rule. A count may not grow, and no new file or
//   rule may appear (ESLint keeps its own baseline, eslint-suppressions.json).
// - coverage-baseline.json: line and branch percentages of the files in scope below the bar. A file in it may not
//   fall below its figures; any other file must reach the bar; a file reaching it leaves the baseline.
// A baseline the code has beaten fails too, until `npm run ratchet -- --update` writes the better figures, so the
// files always state the truth. `--init` writes a missing baseline from today's figures, once.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BAR = 90

export type RuffCounts = Record<string, Record<string, number>>
export type Coverage = { lines: number; branches: number }
export type CoverageByFile = Record<string, Coverage>
export type Verdict<T> = {
  /** What got worse: the check fails and `--update` does not take it. */
  failures: string[]
  /** What got better: the check fails until `--update` writes it. */
  stale: string[]
  /** The baseline with every improvement taken and no regression. */
  updated: T
}

type RuffViolation = { filename: string; code: string | null }

export function ruffCounts(report: RuffViolation[], root: string): RuffCounts {
  const counts: RuffCounts = {}
  for (const { filename, code } of report) {
    const file = relative(root, filename)
    const rules = (counts[file] ??= {})
    const rule = code ?? 'syntax'
    rules[rule] = (rules[rule] ?? 0) + 1
  }
  return counts
}

const pairs = (counts: RuffCounts) =>
  Object.entries(counts).flatMap(([file, rules]) => Object.entries(rules).map(([rule, n]) => ({ file, rule, n })))

export function checkRuff(baseline: RuffCounts, current: RuffCounts): Verdict<RuffCounts> {
  const failures = pairs(current)
    .filter(({ file, rule, n }) => n > (baseline[file]?.[rule] ?? 0))
    .map(({ file, rule, n }) => `${file}: ${rule} grew from ${String(baseline[file]?.[rule] ?? 0)} to ${String(n)}`)
  const stale: string[] = []
  const updated: RuffCounts = {}
  for (const { file, rule, n: was } of pairs(baseline)) {
    const now = Math.min(was, current[file]?.[rule] ?? 0)
    if (now < was) stale.push(`${file}: ${rule} fell from ${String(was)} to ${String(now)}`)
    if (now > 0) updated[file] = { ...updated[file], [rule]: now }
  }
  return { failures: failures.toSorted((a, b) => a.localeCompare(b)), stale, updated }
}

const METRICS = ['lines', 'branches'] as const
const atBar = (c: Coverage) => METRICS.every(m => c[m] >= BAR)

function checkNewFile(file: string, now: Coverage): string[] {
  return METRICS.filter(m => now[m] < BAR).map(m => `${file}: ${m} ${String(now[m])}% is below ${String(BAR)}%`)
}

function checkKnownFile(file: string, was: Coverage, now: Coverage) {
  const failures = METRICS.filter(m => now[m] < was[m]).map(m => `${file}: ${m} fell from ${String(was[m])}% to ${String(now[m])}%`)
  const better = { lines: Math.max(was.lines, now.lines), branches: Math.max(was.branches, now.branches) }
  if (atBar(better)) return { failures, stale: [`${file}: reached ${String(BAR)}%, leaves the baseline`], kept: undefined }
  const stale = METRICS.filter(m => now[m] > was[m]).map(m => `${file}: ${m} rose from ${String(was[m])}% to ${String(now[m])}%`)
  return { failures, stale, kept: better }
}

export function checkCoverage(baseline: CoverageByFile, current: CoverageByFile): Verdict<CoverageByFile> {
  const verdict: Verdict<CoverageByFile> = { failures: [], stale: [], updated: {} }
  for (const [file, now] of Object.entries(current)) {
    const was = baseline[file]
    if (!was) {
      verdict.failures.push(...checkNewFile(file, now))
      continue
    }
    const { failures, stale, kept } = checkKnownFile(file, was, now)
    verdict.failures.push(...failures)
    verdict.stale.push(...stale)
    if (kept) verdict.updated[file] = kept
  }
  for (const file of Object.keys(baseline).filter(f => !(f in current))) {
    verdict.stale.push(`${file}: no longer measured, leaves the baseline`)
  }
  return verdict
}

/** A percentage rounded down to 0.01, so a figure never claims more than was covered. Nothing to cover is 100%. */
const percent = (hit: number, found: number) => (found === 0 ? 100 : Math.floor((hit * 10000) / found) / 100)

export function parseLcov(text: string): CoverageByFile {
  const files: CoverageByFile = {}
  for (const record of text.split('end_of_record')) {
    const field = (name: string) => new RegExp(`^${name}:(.*)$`, 'm').exec(record)?.[1]?.trim()
    const file = field('SF')
    if (!file) continue
    const n = (name: string) => Number(field(name) ?? 0)
    files[file] = { lines: percent(n('LH'), n('LF')), branches: percent(n('BRH'), n('BRF')) }
  }
  return files
}

/** Adds each file in scope that no test loaded, at 0%: node's coverage only lists the files a test imports. */
export function withUnmeasured(coverage: CoverageByFile, scope: string[]): CoverageByFile {
  const unmeasured = scope.filter(file => !(file in coverage)).map(file => [file, { lines: 0, branches: 0 }])
  return { ...coverage, ...Object.fromEntries(unmeasured) as CoverageByFile }
}

type CoverageReport = {
  files: Record<string, { summary: { num_statements: number; covered_lines: number; num_branches: number; covered_branches: number } }>
}

export function parseCoverageJson(report: CoverageReport, folder: string): CoverageByFile {
  const files: CoverageByFile = {}
  for (const [file, { summary: s }] of Object.entries(report.files)) {
    files[`${folder}/${file}`] = { lines: percent(s.covered_lines, s.num_statements), branches: percent(s.covered_branches, s.num_branches) }
  }
  return files
}

// The CLI. Paths are relative to the repo root, where npm runs it.

/** The TypeScript under the bar; python/ is listed whole by coverage.py itself. */
const TS_SCOPE = ['src/core', 'src/server', 'src/hooks']
const RUFF_BASELINE = 'python/ruff-baseline.json'
const COVERAGE_BASELINE = 'coverage-baseline.json'

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path: string, value: unknown) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function measure() {
  const ruff = ruffCounts(readJson('coverage/ruff.json') as RuffViolation[], process.cwd())
  const scope = TS_SCOPE.flatMap(dir => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map(file => join(dir, file)))
  const ts = withUnmeasured(parseLcov(readFileSync('coverage/lcov.info', 'utf8')), scope.filter(f => /(?<!\.test)\.tsx?$/.test(f)))
  return { ruff, coverage: { ...ts, ...parseCoverageJson(readJson('coverage/python.json') as CoverageReport, 'python') } }
}

function init(ruff: RuffCounts, coverage: CoverageByFile): void {
  const below = Object.fromEntries(Object.entries(coverage).filter(([, c]) => !atBar(c)))
  for (const [path, value] of [[RUFF_BASELINE, ruff], [COVERAGE_BASELINE, below]] as const) {
    if (existsSync(path)) console.log(`ratchet: ${path} exists; --init only writes a missing baseline`)
    else writeJson(path, value)
  }
}

function report(verdict: Verdict<unknown>, update: boolean): boolean {
  for (const failure of verdict.failures) console.log(`ratchet: worse: ${failure}`)
  for (const better of verdict.stale) console.log(`ratchet: ${update ? 'updated' : 'better'}: ${better}`)
  return verdict.failures.length === 0 && (update || verdict.stale.length === 0)
}

function main(args: string[]): number {
  const { ruff, coverage } = measure()
  if (args.includes('--init')) {
    init(ruff, coverage)
    return 0
  }
  const update = args.includes('--update')
  const ruffVerdict = checkRuff(readJson(RUFF_BASELINE) as RuffCounts, ruff)
  const coverageVerdict = checkCoverage(readJson(COVERAGE_BASELINE) as CoverageByFile, coverage)
  if (update) {
    writeJson(RUFF_BASELINE, ruffVerdict.updated)
    writeJson(COVERAGE_BASELINE, coverageVerdict.updated)
  }
  const ok = [report(ruffVerdict, update), report(coverageVerdict, update)].every(Boolean)
  if (!ok && !update && ruffVerdict.failures.length + coverageVerdict.failures.length === 0) {
    console.log('ratchet: the baselines are beaten; run `npm run ratchet -- --update` and commit them')
  }
  return ok ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))

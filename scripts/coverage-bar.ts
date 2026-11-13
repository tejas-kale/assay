// The coverage bar (docs/developer/testing.md): every file in scope reaches 90% of its lines and of its branches.
// Node's coverage (coverage/lcov.info) covers src/core, src/server and src/hooks; coverage.py (coverage/python.json)
// covers python/. ESLint and ruff fail on their own; this also refuses an `eslint-suppressions.json`, which would let
// ESLint skip the violations it lists.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BAR = 90

export type Coverage = { lines: number; branches: number }
export type CoverageByFile = Record<string, Coverage>

const METRICS = ['lines', 'branches'] as const

/** Each file and metric below the bar, as a message; none means the bar is met. */
export function belowBar(coverage: CoverageByFile): string[] {
  return Object.entries(coverage)
    .flatMap(([file, c]) => METRICS.filter(m => c[m] < BAR).map(m => `${file}: ${m} ${String(c[m])}% is below ${String(BAR)}%`))
    .toSorted((a, b) => a.localeCompare(b))
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
const MOD_SCOPE = 'plugin/hooks'
const ESLINT_SUPPRESSIONS = 'eslint-suppressions.json'

function measure(): CoverageByFile {
  const scope = TS_SCOPE.flatMap(dir => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map(file => join(dir, file)))
  const mods = readdirSync(MOD_SCOPE).filter(file => /^conversation(?!-model).*\.js$/.test(file)).map(file => join(MOD_SCOPE, file))
  const ts = withUnmeasured(parseLcov(readFileSync('coverage/lcov.info', 'utf8')), [...scope.filter(f => /(?<!\.test)\.tsx?$/.test(f)), ...mods, 'src/cli/runAction.ts'])
  const python = JSON.parse(readFileSync('coverage/python.json', 'utf8')) as CoverageReport
  return { ...ts, ...parseCoverageJson(python, 'python') }
}

function main(): number {
  const failures = belowBar(measure())
  if (existsSync(ESLINT_SUPPRESSIONS)) failures.push(`${ESLINT_SUPPRESSIONS}: fix the violations instead of suppressing them`)
  for (const failure of failures) console.log(`coverage-bar: ${failure}`)
  return failures.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()

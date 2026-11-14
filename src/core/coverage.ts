// Trusted-SQL lexical token coverage across an analysis's SQL runs (specs/delegated-runs.md): lexical tokens that came
// from approved block bodies and dictionary definition expansions divided by lexical tokens in the expanded SQL,
// ignoring comments and whitespace. SQL runs from the trusted tool count as 100% trusted; Python runs are excluded.
import { codeBody, parseRunHeader } from './runs.ts'

/** Where the server writes the analysis's trusted-SQL coverage figure. */
export const COVERAGE_FILE = '.assay/coverage.json'

export type SqlCoverage = {
  trustedTokens: number
  totalTokens: number
  coverage: number | null
}

export type CoverageRun = {
  language?: 'sql' | 'python'
  code: string
  expanded?: string
}

const SKIP_PATTERNS = [/\s+/y, /--[^\n]*/y, /\/\*[\s\S]*?(?:\*\/|$)/y]
const TOKEN_PATTERNS = [
  /'(?:[^']|'')*'?/y,
  /"(?:[^"]|"")*"?/y,
  /`(?:[^`]|``)*`?/y,
  /<=|>=|<>|!=|::|=>|\|\|/y,
  /\d+(?:\.\d+)?|[A-Za-z_$][\w$]*/y,
]
const INCLUDE_PLACEHOLDER = /\{\{[^{}]*\}\}/g

function matchAt(patterns: readonly RegExp[], sql: string, index: number): string | undefined {
  for (const pattern of patterns) {
    pattern.lastIndex = index
    const hit = pattern.exec(sql)
    if (hit) return hit[0]
  }
  return undefined
}

/** Lexical tokens in a SQL text, ignoring `--` line comments, `/* ... * /` block comments, and whitespace. */
export function sqlTokens(sql: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < sql.length) {
    const skipped = matchAt(SKIP_PATTERNS, sql, i)
    if (skipped) {
      i += skipped.length
    } else {
      const token = matchAt(TOKEN_PATTERNS, sql, i) ?? sql.charAt(i)
      tokens.push(token)
      i += token.length
    }
  }
  return tokens
}

/** Trusted and total lexical SQL tokens for one saved run; Python runs (including trusted Python) contribute 0. */
export function runCoverage(run: CoverageRun): { trustedTokens: number; totalTokens: number } {
  if (run.language === 'python') return { trustedTokens: 0, totalTokens: 0 }
  const header = parseRunHeader(run.code, 'sql')
  const body = codeBody(run.code, 'sql')
  if (header.trusted !== undefined) {
    if (/^-- python:/m.test(body)) return { trustedTokens: 0, totalTokens: 0 }
    const totalTokens = sqlTokens(body).length
    return { trustedTokens: totalTokens, totalTokens }
  }
  if (run.expanded !== undefined && run.expanded !== '') {
    const totalTokens = sqlTokens(run.expanded).length
    const untrustedTokens = sqlTokens(body.replace(INCLUDE_PLACEHOLDER, ' ')).length
    return { trustedTokens: Math.max(0, totalTokens - untrustedTokens), totalTokens }
  }
  return { trustedTokens: 0, totalTokens: sqlTokens(body).length }
}

/** Trusted-SQL lexical token coverage summed across every run in the analysis. */
export function analysisCoverage(runs: readonly CoverageRun[]): SqlCoverage {
  let trustedTokens = 0
  let totalTokens = 0
  for (const run of runs) {
    const counted = runCoverage(run)
    trustedTokens += counted.trustedTokens
    totalTokens += counted.totalTokens
  }
  return {
    trustedTokens,
    totalTokens,
    coverage: totalTokens > 0 ? trustedTokens / totalTokens : null,
  }
}

/** Reads `.assay/coverage.json` safely; undefined when missing or malformed. */
export function parseCoverage(text: string): SqlCoverage | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const trustedTokens: unknown = Reflect.get(raw, 'trustedTokens')
  const totalTokens: unknown = Reflect.get(raw, 'totalTokens')
  const coverage: unknown = Reflect.get(raw, 'coverage')
  if (typeof trustedTokens !== 'number' || typeof totalTokens !== 'number') return undefined
  if (coverage !== null && typeof coverage !== 'number') return undefined
  return { trustedTokens, totalTokens, coverage }
}

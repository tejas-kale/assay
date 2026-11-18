// The npm audit gate (docs/developer/security.md): CI fails on any high or critical advisory in the locked
// dependencies, except an advisory accepted below with the id of its accepted-risk entry. An accepted advisory still
// fails the gate once a fix that `npm audit fix` can apply exists, and once npm stops reporting it, so an exception
// never outlives its reason. The root lockfile only: scripts/mod-runner
// accepts nothing and keeps the plain `npm audit --audit-level=high`. `node scripts/audit-gate.ts`.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Advisories accepted at high or above: GHSA id → the package it is accepted in, and its accepted-risk entry. */
export const ACCEPTED: Readonly<Record<string, { readonly pkg: string; readonly entry: string }>> = {
  'GHSA-fc5q-39xc-vjpf': { pkg: 'picomatch', entry: 'L-11' },
}

const GATED = new Set(['high', 'critical'])

interface Advisory { readonly url: string; readonly severity: string; readonly title?: string }
interface Vulnerability { readonly via: readonly (string | Advisory)[]; readonly fixAvailable: unknown }
export interface AuditReport { readonly vulnerabilities?: Readonly<Record<string, Vulnerability>> }

function ghsa(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1)
}

/**
 * The problems in an `npm audit --json` report: each gated advisory not accepted for its package, each accepted one
 * that `npm audit fix` can now fix, and each accepted one the report no longer holds. A package reported only through
 * another package (a `via` that is a name) adds nothing of its own: its advisories are listed under that package.
 */
export function auditProblems(report: AuditReport, accepted: typeof ACCEPTED = ACCEPTED): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [pkg, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string' || !GATED.has(via.severity)) continue
      const id = ghsa(via.url)
      const exception = accepted[id]
      if (exception?.pkg !== pkg) {
        problems.push(`${pkg}: ${via.severity} ${id} ${via.title ?? ''}`.trimEnd())
        continue
      }
      seen.add(id)
      if (vulnerability.fixAvailable === true) problems.push(`${pkg}: ${id} (${exception.entry}) now has a fix: run npm audit fix and drop the exception`)
    }
  }
  for (const [id, { pkg, entry }] of Object.entries(accepted)) {
    if (!seen.has(id)) problems.push(`${pkg}: ${id} (${entry}) is no longer reported: drop the exception and its entry`)
  }
  return problems
}

function main(): number {
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' })
  let report: AuditReport & { readonly error?: unknown }
  try {
    report = JSON.parse(result.stdout) as AuditReport & { readonly error?: unknown }
  } catch {
    console.error(`npm audit gave no report: ${result.stderr}`)
    return 2
  }
  if (report.error !== undefined) {
    console.error(`npm audit failed: ${JSON.stringify(report.error)}`)
    return 2
  }
  const problems = auditProblems(report)
  for (const problem of problems) console.error(`audit ${problem}`)
  if (problems.length === 0) console.log('No high or critical advisories beyond the accepted ones')
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main())

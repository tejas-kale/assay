// Terminal launches use the same contract as the app; disk facts come from the CLI adapter.
import { join } from 'node:path'

import { ledgerPath } from './trustLedger.ts'
import { spawnSpec } from './session.ts'
import type { SpawnSpec } from './session.ts'

export type OpenFacts = {
  slug?: string
  root?: string
  analyses: string[]
  rootExists: boolean
  backendReady: boolean
  venvReady: boolean
  userData: string
  version: string
  env: Record<string, string | undefined>
}
export type OpenCommand = { kind: 'launch'; spec: SpawnSpec } | { kind: 'list'; message: string } | { kind: 'error'; message: string }

export function openCommand(facts: OpenFacts): OpenCommand {
  const { root, slug, userData, version, env } = facts
  if (!root || !facts.rootExists) return { kind: 'error', message: 'Assay root is missing. Open Assay and choose your root in Settings.' }
  const known = facts.analyses.join('\n') || '(none)'
  if (slug === undefined) return { kind: 'list', message: known }
  if (!facts.analyses.includes(slug)) return { kind: 'error', message: `Unknown analysis: ${slug}\nKnown analyses:\n${known}` }
  if (!facts.backendReady) return { kind: 'error', message: 'Assay backend is missing. Open the installed app once to prepare it.' }
  if (!facts.venvReady) return { kind: 'error', message: 'Assay venv is not ready. Open the app and wait for its backend build.' }
  return { kind: 'launch', spec: spawnSpec({
    folder: join(root, 'analyses', slug), root, env,
    mode: env.ASSAY_THEME === 'light-ansi' ? 'light' : 'dark',
    backend: join(userData, 'backend', version), venv: join(userData, 'venvs', version),
    ledger: ledgerPath(userData, root),
  }) }
}

// Terminal launches use the same contract as the app; disk facts come from the CLI adapter.
import { join } from 'node:path'

import { cleanTitle } from './analyses.ts'
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
/** `notice` is printed before the launch replaces the command. */
export type OpenCommand = { kind: 'launch'; spec: SpawnSpec; notice?: string } | { kind: 'list'; message: string } | { kind: 'error'; message: string }

const rootProblem = (facts: OpenFacts) =>
  !facts.root || !facts.rootExists ? 'Assay root is missing. Open Assay and choose your root in Settings.' : undefined

function backendProblem(facts: OpenFacts) {
  if (!facts.backendReady) return 'Assay backend is missing after preparing it. Reinstall Assay.app from its GitHub release.'
  if (!facts.venvReady) return 'Assay venv is not ready after building it. Run the command again.'
  return undefined
}

export function openCommand(facts: OpenFacts): OpenCommand {
  const { root, slug, userData, version, env } = facts
  const missingRoot = rootProblem(facts)
  if (missingRoot || !root) return { kind: 'error', message: missingRoot ?? '' }
  const known = facts.analyses.join('\n') || '(none)'
  if (slug === undefined) return { kind: 'list', message: known }
  if (!facts.analyses.includes(slug)) return { kind: 'error', message: `Unknown analysis: ${slug}\nKnown analyses:\n${known}` }
  const notReady = backendProblem(facts)
  if (notReady) return { kind: 'error', message: notReady }
  return { kind: 'launch', spec: spawnSpec({
    folder: join(root, 'analyses', slug), root, env,
    mode: env.ASSAY_THEME === 'light-ansi' ? 'light' : 'dark',
    backend: join(userData, 'backend', version), venv: join(userData, 'venvs', version),
    ledger: ledgerPath(userData, root),
  }) }
}

/**
 * `assay new <title>`: creates the analysis as the app's picker does, then opens it. Refuses before writing anything
 * when the title has nothing to slug or the launch could not follow. `create` makes the folder under the root and returns its slug.
 */
export async function newCommand(facts: OpenFacts, title: string, create: (root: string, title: string) => Promise<string>): Promise<OpenCommand> {
  const cleaned = cleanTitle(title)
  if (!cleaned.ok) return { kind: 'error', message: cleaned.message }
  const problem = rootProblem(facts) ?? backendProblem(facts)
  if (problem || !facts.root) return { kind: 'error', message: problem ?? '' }
  const slug = await create(facts.root, cleaned.title)
  const opened = openCommand({ ...facts, slug, analyses: [...facts.analyses, slug] })
  return opened.kind === 'launch' ? { ...opened, notice: `Created analyses/${slug}` } : opened
}

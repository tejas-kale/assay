// Terminal launches use the same contract as the app; disk facts come from the CLI adapter.
import { join } from 'node:path'

import { cleanTitle } from './analyses.ts'
import { slugify } from './rootNotes.ts'
import { ledgerPath } from './trustLedger.ts'
import { spawnSpec } from './session.ts'
import type { SpawnSpec } from './session.ts'

export type OpenFacts = {
  /** What the user typed after `open`: a folder name, a title, or words to match. */
  slug?: string
  root?: string
  /** Most recently changed first, as the picker lists them. */
  analyses: Choice[]
  rootExists: boolean
  backendReady: boolean
  venvReady: boolean
  userData: string
  version: string
  env: Record<string, string | undefined>
}
export type Choice = { name: string; title: string }
/**
 * `notice` is printed before the launch replaces the command. `choose`: a terminal asks which analysis to open, or
 * which to create, searching from what was typed; output that is not a terminal gets `message` instead, as an error
 * when `failed`.
 */
export type OpenCommand =
  | { kind: 'launch'; spec: SpawnSpec; notice?: string }
  | { kind: 'choose'; message: string; failed?: true }
  | { kind: 'error'; message: string }

const sameText = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()

/** The analysis a typed name means: its folder name, else its title in any case, else the folder its words would make. */
export function resolveAnalysis(typed: string, analyses: Choice[]): string | undefined {
  return (analyses.find(a => a.name === typed) ?? analyses.find(a => sameText(a.title, typed)) ?? analyses.find(a => a.name === slugify(typed)))?.name
}

const rootProblem = (facts: OpenFacts) =>
  !facts.root || !facts.rootExists ? 'Assay root is missing. Run assay root <path>, or choose your root in Assay Settings.' : undefined

function backendProblem(facts: OpenFacts) {
  if (!facts.backendReady) return 'Assay backend is missing after preparing it. Reinstall Assay.app from its GitHub release.'
  if (!facts.venvReady) return 'Assay venv is not ready after building it. Run the command again.'
  return undefined
}

export function openCommand(facts: OpenFacts): OpenCommand {
  const { root, slug, userData, version, env } = facts
  const missingRoot = rootProblem(facts)
  if (missingRoot || !root) return { kind: 'error', message: missingRoot ?? '' }
  const known = facts.analyses.map(a => a.name).join('\n') || '(none)'
  if (slug === undefined) return { kind: 'choose', message: known }
  const name = resolveAnalysis(slug, facts.analyses)
  if (!name) return { kind: 'choose', message: `Unknown analysis: ${slug}\nKnown analyses:\n${known}`, failed: true }
  const notReady = backendProblem(facts)
  if (notReady) return { kind: 'error', message: notReady }
  return { kind: 'launch', spec: spawnSpec({
    folder: join(root, 'analyses', name), root, env,
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
  const opened = openCommand({ ...facts, slug, analyses: [...facts.analyses, { name: slug, title: cleaned.title }] })
  return opened.kind === 'launch' ? { ...opened, notice: `Created analyses/${slug}` } : opened
}

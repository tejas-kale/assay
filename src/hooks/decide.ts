// The hooks' decisions as plain functions of their input and environment, so tests can call them directly.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { access, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

import { bashRunsPython, BASH_PYTHON_DENY } from '../core/bashGuard.ts'
import { folderName, openAnalysis } from '../core/analyses.ts'
import { DICTIONARIES, isGuarded, normalPath, otherAnalysis, serverOwned, TRUST_TAB, TRUSTED } from '../core/calculations.ts'
import type { CalculationList } from '../core/calculations.ts'
import { inRootNotes, NOTES_DIR } from '../core/rootNotes.ts'
import { stripTrailingSlashes } from '../core/slugText.ts'
import { promptContext, runNotice, toolName, userRuns } from '../core/rules.ts'
import type { OpenAnalysis, UserRun } from '../core/rules.ts'
import { deny, addContext, field, toolInput } from './io.ts'
import type { Proc } from '../server/proc.ts'

type Env = Record<string, string | undefined>

/** Where a dangling symlink points, or undefined when `path` is not a symlink. */
function linkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? normalPath(readlinkSync(path), dirname(path)) : undefined
  } catch {
    return undefined
  }
}

/**
 * A path with symlinks resolved as far as it exists: the deepest existing ancestor is resolved, the rest appended. A
 * dangling symlink is followed to where it points, since writing through it creates that file.
 */
function realPath(path: string, base: string): string {
  let at = normalPath(path, base)
  const rest: string[] = []
  for (let hops = 0; ; ) {
    try {
      return join(realpathSync.native(at), ...rest)
    } catch {
      const target = hops < 40 ? linkTarget(at) : undefined
      if (target !== undefined) {
        hops++
        at = target
        continue
      }
      const parent = dirname(at)
      if (parent === at) return join(at, ...rest)
      rest.unshift(basename(at))
      at = parent
    }
  }
}

/** PreToolUse on Bash: Python goes through the python tool, in the kernel the user sees. Only in an Assay session. */
export function bashDecision(input: Record<string, unknown>, env: Env) {
  if (!env.ASSAY_ANALYSIS) return undefined
  return bashRunsPython(field(toolInput(input), 'command')) ? deny(BASH_PYTHON_DENY) : undefined
}

/** The open analysis for the rules and reasons: its title (the folder's name when analysis.yaml has none) and its folder from the root. */
async function openRef(analysis: string, home: string): Promise<OpenAnalysis> {
  const fallback = folderName(analysis)
  const found = await openAnalysis({ readFile: path => readFile(path, 'utf8') }, analysis).catch(() => undefined)
  return { title: found?.title ?? fallback, folder: relative(home, analysis) }
}

/** PreToolUse on Write, Edit, MultiEdit and NotebookEdit: never into the shared dictionaries/, trusted/ or notes/, the root's git, the analysis's .assay/ or queries/, nor into another analysis. */
export async function writeDecision(input: Record<string, unknown>, env: Env) {
  const home = env.ASSAY_ROOT
  if (!home || !env.ASSAY_ANALYSIS) return undefined
  const tool = toolInput(input)
  const path = field(tool, 'file_path') || field(tool, 'notebook_path')
  const base = field(input, 'cwd') || env.ASSAY_ANALYSIS
  if (!path) return undefined
  const root = stripTrailingSlashes(home)
  const real = realPath(path, base)
  const realRoot = realPath(root, '/')
  const other = otherAnalysis(real, realRoot, realPath(env.ASSAY_ANALYSIS, '/'), '/')
  if (other) {
    const open = await openRef(env.ASSAY_ANALYSIS, root)
    return deny(`${other} is not the open analysis. The open analysis is "${open.title}" (${open.folder}/): write only there.`)
  }
  const installed = [env.ASSAY_BACKEND, env.ASSAY_VENV].filter((folder): folder is string => Boolean(folder)).map(folder => stripTrailingSlashes(folder))
  const analysis = normalPath(env.ASSAY_ANALYSIS, '/')
  const realAnalysis = realPath(analysis, '/')
  // The path as the real file system has it, and as it is named: through a symlinked protected folder the real path
  // lies outside the folder's name and the named path outside its destination, so each is checked, and the real path
  // is also taken back to the protected folder it lands in.
  const candidates = [
    { path: real, home: realRoot, analysis: realAnalysis, installed: installed.map(folder => realPath(folder, '/')) },
    ...[normalPath(path, base), ...namedFolders(real, root, analysis, installed)].map(named => ({ path: named, home: normalPath(root, '/'), analysis, installed })),
  ]
  for (const candidate of candidates) {
    const refused = refusal(candidate.path, candidate, path)
    if (refused) return deny(refused)
  }
  return undefined
}

/** The protected folders, by name: what only Assay or the user's approval writes. */
const protectedFolders = (home: string, analysis: string, installed: readonly string[]) => [
  ...[TRUSTED, DICTIONARIES, NOTES_DIR, '.git'].map(name => `${normalPath(home, '/')}/${name}`),
  ...['.assay', 'queries', '.git'].map(name => `${analysis}/${name}`),
  ...installed.map(folder => normalPath(folder, '/')),
]

/** `real` taken back to the name of each protected folder whose real path it is in (a folder that is a symlink, or dangles). */
function namedFolders(real: string, home: string, analysis: string, installed: readonly string[]): string[] {
  const lower = real.toLowerCase()
  return protectedFolders(home, analysis, installed).flatMap(folder => {
    const at = realPath(folder, '/')
    return lower === at.toLowerCase() || lower.startsWith(`${at.toLowerCase()}/`) ? [`${folder}${real.slice(at.length)}`] : []
  })
}

type Place = { home: string; analysis: string; installed: readonly string[] }

/** Why a Write to `full` is refused, or undefined. `shown` is the path as Claude gave it. */
function refusal(full: string, place: Place, shown: string): string | undefined {
  const owned = serverOwned(full, place.home, place.analysis, place.installed)
  if (owned) {
    return `${shown} is in ${owned}, which only Assay writes: runs come from ${toolName('sql')} and ${toolName('python')}, and the app's requests and the git history from the user. Never Write or Edit there.`
  }
  if (inRootNotes(full, place.home)) {
    return `Root notes change only through the note tools: ${toolName('note')} writes one, ${toolName('revise_note')} changes or deletes one, ${toolName('link_notes')} records the ones this analysis found. Read ${shown} to see it; never Write or Edit under notes/.`
  }
  if (!isGuarded(full, place.home, '/')) return undefined
  return `${shown} is in the data dictionary or the trusted calculations, which change only through the user's approval. Draft it under lib/dictionaries/ or lib/trusted/ in the analysis, and ask the user to check it in ${TRUST_TAB}.`
}

/** A list the server appended to under `.assay/`, taken: the file is moved away first, then read and removed. */
async function takeList(analysis: string, name: string): Promise<unknown[]> {
  const file = join(analysis, '.assay', name)
  const taken = `${file}.${String(process.pid)}.taken`
  try {
    await rename(file, taken)
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(taken, 'utf8'))
    return Array.isArray(parsed) ? (parsed as unknown[]) : []
  } catch {
    return []
  } finally {
    await rm(taken, { force: true }).catch(() => undefined)
  }
}

/** The user's runs the server recorded since the last prompt. */
const takeUserRuns = async (analysis: string): Promise<UserRun[]> => userRuns(await takeList(analysis, 'user-runs.json'))

/** The step checks that failed since the last prompt, one line each. */
const takeStepNotices = async (analysis: string) => (await takeList(analysis, 'step-notices.json')).filter((line): line is string => typeof line === 'string')

/** The kernel's python as the server last started it, if it said. */
async function kernelPython(analysis: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(analysis, '.assay/session.json'), 'utf8')) as { python?: unknown } | null
    return typeof parsed?.python === 'string' ? parsed.python : undefined
  } catch {
    return undefined
  }
}

/** The trusted calculations, listed by the helper with Assay's venv's python; undefined when it cannot. */
async function calculations(proc: Proc, python: string | undefined, analysis: string, home: string): Promise<CalculationList | undefined> {
  if (!python) return undefined
  const ran = await proc.run([python, '-I', '-m', 'analysis_trust', 'list', home], { cwd: analysis, timeoutMs: 30_000 }).catch(() => undefined)
  try {
    const parsed = JSON.parse(ran?.stdout ?? '') as CalculationList | { error: string }
    return typeof parsed === 'object' && 'calculations' in parsed ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * UserPromptSubmit: the rules on each prompt the user types (Claude Code runs this hook for those only), the trusted
 * calculations, and the user's runs and failed step checks since the last prompt. Only in an Assay session.
 */
export async function promptDecision(env: Env, proc: Proc) {
  const analysis = env.ASSAY_ANALYSIS
  const home = env.ASSAY_ROOT
  if (!analysis || !home) return undefined
  const venvPython = env.ASSAY_VENV ? `${env.ASSAY_VENV}/bin/python` : undefined
  const [runs, stepLines, python, list] = await Promise.all([takeUserRuns(analysis), takeStepNotices(analysis), kernelPython(analysis), calculations(proc, venvPython, analysis, home)])
  const open = await openRef(analysis, home)
  const notice = runNotice(runs, open.folder, stepLines)
  // The kernel's python, else Assay's venv's when it is built.
  const named = python ?? (venvPython && (await access(venvPython).then(() => venvPython, () => undefined)))
  return addContext(promptContext({ python: named, ...(notice ? { notice } : {}), home, list, open }))
}

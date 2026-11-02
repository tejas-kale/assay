// The hooks' decisions as plain functions of their input and environment, so tests can call them directly.
import { realpathSync } from 'node:fs'
import { access, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

import { bashRunsPython, BASH_PYTHON_DENY } from '../core/bashGuard.ts'
import { folderName, openAnalysis } from '../core/analyses.ts'
import { isGuarded, normalPath, otherAnalysis, TRUST_TAB } from '../core/calculations.ts'
import type { CalculationList } from '../core/calculations.ts'
import { inRootNotes } from '../core/rootNotes.ts'
import { promptContext, runNotice, toolName, VENV_ASSAY } from '../core/rules.ts'
import type { OpenAnalysis, UserRun } from '../core/rules.ts'
import { deny, addContext, field, toolInput } from './io.ts'
import type { Proc } from '../server/proc.ts'

type Env = Record<string, string | undefined>

/** A path with symlinks resolved as far as it exists: the deepest existing ancestor is resolved, the rest appended. */
function realPath(path: string, base: string): string {
  let at = normalPath(path, base)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest)
    } catch {
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

/** PreToolUse on Write, Edit and NotebookEdit: never into the shared dictionaries/, trusted/ or notes/, nor into another analysis. */
export async function writeDecision(input: Record<string, unknown>, env: Env) {
  const home = env.ASSAY_ROOT
  if (!home || !env.ASSAY_ANALYSIS) return undefined
  const tool = toolInput(input)
  const path = field(tool, 'file_path') || field(tool, 'notebook_path')
  const base = field(input, 'cwd') || env.ASSAY_ANALYSIS
  if (!path) return undefined
  const root = home.replace(/\/+$/, '')
  const real = realPath(path, base)
  const realRoot = realPath(root, '/')
  const other = otherAnalysis(real, realRoot, realPath(env.ASSAY_ANALYSIS, '/'), '/')
  if (other) {
    const open = await openRef(env.ASSAY_ANALYSIS, root)
    return deny(`${other} is not the open analysis. The open analysis is "${open.title}" (${open.folder}/): write only there.`)
  }
  if (inRootNotes(real, realRoot)) {
    return deny(`Root notes change only through the note tools: ${toolName('note')} writes one, ${toolName('revise_note')} changes or deletes one, ${toolName('link_notes')} records the ones this analysis found. Read ${path} to see it; never Write or Edit under notes/.`)
  }
  if (!isGuarded(real, realRoot, '/')) return undefined
  return deny(
    `${path} is in the data dictionary or the trusted calculations, which change only through the user's approval. Draft it under lib/dictionaries/ or lib/trusted/ in the analysis, and ask the user to check it in ${TRUST_TAB}.`,
  )
}

/** The user's runs the server recorded since the last prompt, taken (the file is moved away first, then read). */
async function takeUserRuns(analysis: string): Promise<UserRun[]> {
  const file = join(analysis, '.assay/user-runs.json')
  const taken = `${file}.${process.pid}.taken`
  try {
    await rename(file, taken)
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(taken, 'utf8'))
    return Array.isArray(parsed) ? (parsed as UserRun[]) : []
  } catch {
    return []
  } finally {
    await rm(taken, { force: true }).catch(() => undefined)
  }
}

/** The kernel's python as the server last started it, if it said. */
async function kernelPython(analysis: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(analysis, '.assay/session.json'), 'utf8')) as { python?: unknown } | null
    return typeof parsed?.python === 'string' ? parsed.python : undefined
  } catch {
    return undefined
  }
}

/** The trusted calculations, listed by the helper with venv-assay's python; undefined when it cannot. */
async function calculations(proc: Proc, env: Env, analysis: string, home: string): Promise<CalculationList | undefined> {
  const python = `${env.ASSAY_VENV || VENV_ASSAY}/bin/python`
  const ran = await proc.run([python, '-m', 'analysis_trust', 'list', home], { cwd: analysis, timeoutMs: 30_000 }).catch(() => undefined)
  try {
    const parsed = JSON.parse(ran?.stdout ?? '') as CalculationList | { error: string }
    return parsed && typeof parsed === 'object' && 'calculations' in parsed ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * UserPromptSubmit: the rules on each prompt the user types (Claude Code runs this hook for those only), the trusted
 * calculations, and the user's runs since the last prompt. Only in an Assay session.
 */
export async function promptDecision(env: Env, proc: Proc) {
  const analysis = env.ASSAY_ANALYSIS
  const home = env.ASSAY_ROOT
  if (!analysis || !home) return undefined
  const [runs, python, list] = await Promise.all([takeUserRuns(analysis), kernelPython(analysis), calculations(proc, env, analysis, home)])
  const open = await openRef(analysis, home)
  const notice = runNotice(runs, open.folder)
  // The kernel's python, else venv-assay's when it is built (as the mod's rules named it).
  const venvPython = `${env.ASSAY_VENV || VENV_ASSAY}/bin/python`
  const named = python ?? (await access(venvPython).then(() => venvPython, () => undefined))
  return addContext(promptContext({ python: named, ...(notice ? { notice } : {}), home, list, open }))
}

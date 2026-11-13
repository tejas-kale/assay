// `assay vd`: which analysis and run to show in VisiData, and the files to open. The CLI adapter (src/cli) reads the
// disk and replaces itself with vd.
import { join } from 'node:path'

import { analysisSlug } from './analyses.ts'
import { resolveAnalysis } from './open.ts'
import type { Choice } from './open.ts'
import { parseRuns } from './runs.ts'

export type VdTarget = { analysis: string; run?: number }

/** A run number is all digits; any other word names the analysis, in either order. */
export function vdArgs(args: readonly string[]): { run?: number; name?: string } {
  const run = args.find(arg => /^\d+$/.test(arg))
  const name = args.find(arg => arg !== run)
  return { ...(run === undefined ? {} : { run: Number(run) }), ...(name === undefined ? {} : { name }) }
}

/**
 * The analysis to show: the one named, else the one the terminal is in (or below), else the most recently changed.
 * `analyses` are most recently changed first.
 */
export function vdTarget(args: readonly string[], facts: { cwd: string; root?: string; analyses: Choice[] }): VdTarget | { error: string } {
  const { run, name } = vdArgs(args)
  const withRun = (analysis: string) => ({ analysis, ...(run === undefined ? {} : { run }) })
  if (!facts.root) return { error: 'Assay root is missing. Run assay root <path>, or choose your root in Assay Settings.' }
  if (name !== undefined) {
    const found = resolveAnalysis(name, facts.analyses)
    return found ? withRun(found) : { error: `No analysis matches "${name}". Run assay open to see them.` }
  }
  const here = facts.analyses.find(a => cwdIn(facts.cwd, facts.root ?? '', a.name))
  const latest = here ?? facts.analyses[0]
  return latest ? withRun(latest.name) : { error: 'No analyses yet. Run assay new <title> to start one.' }
}

function cwdIn(cwd: string, root: string, name: string): boolean {
  const folder = join(root, 'analyses', name)
  return analysisSlug(folder, root) === name && (cwd === folder || cwd.startsWith(`${folder}/`))
}

/**
 * The table files of run `run` in `queries/` (the newest run with a table when undefined), as names inside it: a SQL
 * run's `.csv`, or each table of a Python run in K order.
 */
export function vdFiles(names: readonly string[], run?: number): { run: number; files: string[] } | { error: string } {
  const runs = parseRuns(names)
  const tables = (r: (typeof runs)[number]) => (r.data ? [r.data] : [...r.tables])
  if (run === undefined) {
    const newest = runs.findLast(r => tables(r).length > 0)
    return newest ? { run: newest.number, files: tables(newest) } : { error: 'No run in this analysis has a table yet.' }
  }
  const found = runs.find(r => r.number === run)
  const newest = runs.at(-1)
  if (!found) return { error: [`No run ${String(run)} in this analysis.`, ...(newest ? [`The newest is ${String(newest.number)}.`] : [])].join(' ') }
  const files = tables(found)
  return files.length > 0 ? { run, files } : { error: `Run ${String(run)} has no table: it failed, or saved none.` }
}

/** The first `vd` on PATH; undefined when there is none. */
export async function findOnPath(command: string, path: string, isExecutable: (file: string) => Promise<boolean>): Promise<string | undefined> {
  for (const folder of path.split(':').filter(Boolean)) {
    const file = join(folder, command)
    if (await isExecutable(file)) return file
  }
  return undefined
}

export const VD_MISSING = 'VisiData (vd) is not on PATH. Install it with: uv tool install visidata'

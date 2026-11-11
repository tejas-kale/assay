// The one-off migration to the root layout (slice 6): every marked folder under `analyses/`, `investigations/` and
// `explorations/` becomes `analyses/<slug>/` holding `analysis.yaml`, and `.analysis` goes. Dry run unless `apply`.
// It never overwrites, never touches git, and a rerun finds nothing to do.
import { readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { byCodeUnit } from './codeUnitOrder.ts'
import { slugify } from '../core/rootNotes.ts'
import { ANALYSIS_FILE, isoDay, parseAnalysisFile, slugFor, yamlScalar } from '../core/analyses.ts'

const OLD_MARKER = '.analysis'
const OLD_MARKER_TEXT = '# Marks this folder for the analysis mod.'
const MOVED_FROM = ['investigations', 'explorations'] as const

export type Step = { from: string; to: string; title: string; created: string; isMove: boolean; /** Why the slug differs from the folder name: only the slug rule, or a clash. */ change: '' | 'slugified' | 'numbered' }
export type Report = { steps: Step[]; leftAlone: string[] }

const dirs = async (path: string): Promise<string[]> => {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries.filter(each => each.isDirectory() && !each.name.startsWith('.')).map(each => each.name).sort(byCodeUnit)
}
const isFile = (path: string) => stat(path).then(info => info.isFile(), () => false)

/** "churn_in-q3" becomes "Churn in q3": hyphens and underscores to spaces, first letter upper case. */
export const titleFromFolder = (name: string) => {
  const spaced = name.replace(/[-_]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const day = (ms: number) => isoDay(new Date(ms))

/** The day of the oldest run file in `queries/`, else of the folder's own change time. */
async function createdOn(folder: string, folderMs: number): Promise<string> {
  const names = (await readdir(join(folder, 'queries')).catch(() => [])).filter(name => /^\d+_/.test(name))
  const times = await Promise.all(names.map(name => stat(join(folder, 'queries', name)).then(info => info.mtimeMs, () => Infinity)))
  const oldest = Math.min(...times)
  return day(Number.isFinite(oldest) ? oldest : folderMs)
}

/** analysis.yaml's text: the title and day first, then the old marker's own lines (its keys) as they were. */
export function yamlFor(title: string, created: string, oldMarker: string): string {
  const kept = oldMarker
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && line.trim() !== OLD_MARKER_TEXT)
  const have = parseAnalysisFile(kept.join('\n'))
  return [...(have.title ? [] : [`title: ${yamlScalar(title)}`]), ...(have.created ? [] : [`created: ${created}`]), ...kept].join('\n') + '\n'
}

/** Whether a folder is marked and ready to migrate; when not, the note for "left alone" if it needs one. */
async function readiness(folder: string, label: string): Promise<{ ready: boolean; note?: string }> {
  const migrated = await isFile(join(folder, ANALYSIS_FILE))
  if (!(await isFile(join(folder, OLD_MARKER)))) {
    // A folder already holding analysis.yaml is migrated; any other is the user's to decide about.
    return { ready: false, note: migrated ? undefined : `${label} (no ${OLD_MARKER})` }
  }
  if (migrated) return { ready: false, note: `${label} (has both ${OLD_MARKER} and ${ANALYSIS_FILE}; nothing is overwritten)` }
  return { ready: true }
}

const changeOf = (slug: string, name: string): Step['change'] => {
  if (slug === name) return ''
  return slug === slugify(name) ? 'slugified' : 'numbered'
}

/** Moves the folder if it must, then writes analysis.yaml from the old marker and removes the marker. */
async function applyStep(root: string, folder: string, step: Step): Promise<void> {
  const info = await stat(folder)
  // Move first: a failed move leaves the folder as it was, still marked, for a rerun to find.
  const target = join(root, step.to)
  if (step.isMove) await rename(folder, target)
  const oldMarker = await readFile(join(target, OLD_MARKER), 'utf8').catch(() => '')
  await writeFile(join(target, ANALYSIS_FILE), yamlFor(step.title, step.created, oldMarker), { flag: 'wx' })
  await rm(join(target, OLD_MARKER))
  // The picker sorts by the folder's change time: writing the file must not make every analysis new.
  await utimes(target, info.atime, info.mtime)
}

/** The step for a marked folder; a move takes its slug from `taken`. */
async function planStep(parent: string, name: string, folder: string, taken: Set<string>): Promise<Step> {
  // A folder moves when it is outside analyses/ or its name is not already a slug.
  const isMove = parent !== 'analyses' || slugify(name) !== name
  const slug = isMove ? slugFor(name, taken) : name
  const info = await stat(folder)
  if (isMove) taken.add(slug)
  return { from: `${parent}/${name}`, to: `analyses/${slug}`, title: titleFromFolder(name), created: await createdOn(folder, info.mtimeMs), isMove, change: changeOf(slug, name) }
}

/** What the migration does for `root`; changes the disk only when `apply`. */
export async function migrateRoot(root: string, apply: boolean): Promise<Report> {
  const steps: Step[] = []
  const leftAlone: string[] = []
  // Every entry counts as taken (files and dot-names too), so a move never targets an existing path.
  const taken = new Set(await readdir(join(root, 'analyses')).catch(() => [] as string[]))

  for (const parent of ['analyses', ...MOVED_FROM]) {
    for (const name of await dirs(join(root, parent))) {
      const folder = join(root, parent, name)
      const label = `${parent}/${name}`
      const { ready, note } = await readiness(folder, label)
      if (note !== undefined) leftAlone.push(note)
      if (!ready) continue
      const step = await planStep(parent, name, folder, taken)
      steps.push(step)
      if (apply) await applyStep(root, folder, step)
    }
  }
  return { steps, leftAlone }
}

const plural = (n: number) => (n === 1 ? '' : 's')
const MOVE_NOTE: Record<Step['change'], string> = { '': '', slugified: ' (slugified)', numbered: ' (slug taken, numbered)' }

/** The report as the command prints it, one line per folder, then what was left alone. */
export function printReport(report: Report, apply: boolean): string {
  const lines = report.steps.map(step => {
    const parts = [
      ...(step.isMove ? [`move to ${step.to}${MOVE_NOTE[step.change]}`] : []),
      `write ${ANALYSIS_FILE} (title "${step.title}", created ${step.created})`,
      `remove ${OLD_MARKER}`,
    ]
    return `${step.from}: ${parts.join(', ')}`
  })
  if (report.steps.length === 0) lines.push('Nothing to migrate.')
  if (report.leftAlone.length > 0) lines.push('', 'Left alone:', ...report.leftAlone.map(each => `  ${each}`))
  lines.push('', apply ? `Applied: ${String(report.steps.length)} folder${plural(report.steps.length)}. Commit the changes in the root's repository yourself.` : 'Dry run: nothing changed. Run again with --apply to do it.')
  return `${lines.join('\n')}\n`
}

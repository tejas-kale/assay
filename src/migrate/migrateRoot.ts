// The one-off migration to the root layout (slice 6): every marked folder under `analyses/`, `investigations/` and
// `explorations/` becomes `analyses/<slug>/` holding `analysis.yaml`, and `.analysis` goes. Dry run unless `apply`.
// It never overwrites, never touches git, and a rerun finds nothing to do.
import { readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ANALYSIS_FILE, parseAnalysisFile, yamlScalar } from '../core/analyses.ts'

const OLD_MARKER = '.analysis'
const OLD_MARKER_TEXT = '# Marks this folder for the analysis mod.'
const MOVED_FROM = ['investigations', 'explorations'] as const

export type Step = { from: string; to: string; title: string; created: string; isMove: boolean; isRenamed: boolean }
export type Report = { steps: Step[]; leftAlone: string[] }

const dirs = async (path: string): Promise<string[]> => {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries.filter(each => each.isDirectory() && !each.name.startsWith('.')).map(each => each.name).sort()
}
const isFile = (path: string) => stat(path).then(info => info.isFile(), () => false)

/** "churn_in-q3" becomes "Churn in q3": hyphens and underscores to spaces, first letter upper case. */
export const titleFromFolder = (name: string) => {
  const spaced = name.replace(/[-_]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const day = (ms: number) => new Date(ms).toLocaleDateString('sv')

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

/** What the migration does for `root`; changes the disk only when `apply`. */
export async function migrateRoot(root: string, apply: boolean): Promise<Report> {
  const steps: Step[] = []
  const leftAlone: string[] = []
  const taken = new Set(await dirs(join(root, 'analyses')))

  for (const parent of ['analyses', ...MOVED_FROM]) {
    for (const name of await dirs(join(root, parent))) {
      const folder = join(root, parent, name)
      const label = `${parent}/${name}`
      if (!(await isFile(join(folder, OLD_MARKER)))) {
        // A folder already holding analysis.yaml is migrated; any other is the user's to decide about.
        if (!(await isFile(join(folder, ANALYSIS_FILE)))) leftAlone.push(`${label} (no ${OLD_MARKER})`)
        continue
      }
      if (await isFile(join(folder, ANALYSIS_FILE))) {
        leftAlone.push(`${label} (has both ${OLD_MARKER} and ${ANALYSIS_FILE}; nothing is overwritten)`)
        continue
      }
      const isMove = parent !== 'analyses'
      let slug = name
      if (isMove) for (let n = 2; taken.has(slug); n++) slug = `${name}-${n}`
      const info = await stat(folder)
      const step: Step = { from: label, to: `analyses/${slug}`, title: titleFromFolder(name), created: await createdOn(folder, info.mtimeMs), isMove, isRenamed: slug !== name }
      steps.push(step)
      if (isMove) taken.add(slug)
      if (!apply) continue

      const oldMarker = await readFile(join(folder, OLD_MARKER), 'utf8').catch(() => '')
      await writeFile(join(folder, ANALYSIS_FILE), yamlFor(step.title, step.created, oldMarker), { flag: 'wx' })
      await rm(join(folder, OLD_MARKER))
      const target = join(root, step.to)
      if (isMove) await rename(folder, target)
      // The picker sorts by the folder's change time: writing the file must not make every analysis new.
      await utimes(target, info.atime, info.mtime)
    }
  }
  return { steps, leftAlone }
}

/** The report as the command prints it, one line per folder, then what was left alone. */
export function printReport(report: Report, apply: boolean): string {
  const lines = report.steps.map(step => {
    const parts = [
      ...(step.isMove ? [`move to ${step.to}${step.isRenamed ? ' (slug taken, numbered)' : ''}`] : []),
      `write ${ANALYSIS_FILE} (title "${step.title}", created ${step.created})`,
      `remove ${OLD_MARKER}`,
    ]
    return `${step.from}: ${parts.join(', ')}`
  })
  if (report.steps.length === 0) lines.push('Nothing to migrate.')
  if (report.leftAlone.length > 0) lines.push('', 'Left alone:', ...report.leftAlone.map(each => `  ${each}`))
  lines.push('', apply ? `Applied: ${report.steps.length} folder${report.steps.length === 1 ? '' : 's'}. Commit the changes in the root's repository yourself.` : 'Dry run: nothing changed. Run again with --apply to do it.')
  return `${lines.join('\n')}\n`
}

// The overview documents of an analysis and its system (specs/slices/slice-10.md, slice 10a): reading them with their
// baselines, the change signature the poll watches, and "Mark read".
import { mkdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { OVERVIEW_FILE, baselinePath, systemOf } from '../core/overview.ts'
import type { OverviewDoc, OverviewState, OverviewWhich } from '../core/overview.ts'
import { statSignature } from '../core/watch.ts'
import type { EditResult } from '../shared/ipc.ts'
import { maybeText, rootOf, writeAtomic } from './fsAccess.ts'

/** One document with its baseline, read from the analysis folder (`path` is what the state shows, from the root). */
async function readDoc(analysisPath: string, shown: { path: string; text: string; which: OverviewWhich; system?: string }): Promise<OverviewDoc> {
  const base = baselinePath(shown.which, shown.system)
  const baseline = base === undefined ? undefined : await maybeText(join(analysisPath, base))
  return { path: shown.path, text: shown.text, ...(baseline === undefined ? {} : { baseline }) }
}

/**
 * The analysis overview, the system overview it names, and the baseline of each (specs/slices/slice-10.md, slice 10a). Paths
 * in the state are from the root.
 */
export async function readOverview(analysisPath: string): Promise<OverviewState> {
  const text = await maybeText(join(analysisPath, OVERVIEW_FILE))
  if (text === undefined) return {}
  const state: OverviewState = {
    analysis: await readDoc(analysisPath, { path: `analyses/${basename(analysisPath)}/${OVERVIEW_FILE}`, text, which: 'analysis' }),
  }
  const system = systemOf(text)
  if (!system) return state
  state.system = system
  const systemText = await maybeText(join(rootOf(analysisPath), system))
  if (systemText !== undefined) state.systemDoc = await readDoc(analysisPath, { path: system, text: systemText, which: 'system', system })
  return state
}

/** A signature of the overview files and their baselines, so main pushes the state when any of them changes. */
export async function overviewSignature(analysisPath: string): Promise<string> {
  const text = (await maybeText(join(analysisPath, OVERVIEW_FILE))) ?? ''
  const system = systemOf(text)
  const paths = [join(analysisPath, OVERVIEW_FILE), join(analysisPath, baselinePath('analysis', undefined) ?? '')]
  if (system) paths.push(join(rootOf(analysisPath), system), join(analysisPath, baselinePath('system', system) ?? ''))
  const parts = await Promise.all(paths.map(async path => statSignature(await stat(path).catch(() => undefined))))
  return parts.join('|')
}

/** The text of the document `which` names now, or undefined when there is no such document. */
async function currentOverviewText(analysisPath: string, which: OverviewWhich, text: string, system: string | undefined) {
  if (which === 'analysis') return text
  return system ? maybeText(join(rootOf(analysisPath), system)) : undefined
}

/**
 * "Mark read": the shown document's text becomes its baseline, when the file still holds `expectedText` (what the tab
 * showed); else `stale`, so the user never marks read a text they did not see.
 */
export async function markOverviewRead(analysisPath: string, which: OverviewWhich, expectedText: string): Promise<EditResult> {
  const text = (await maybeText(join(analysisPath, OVERVIEW_FILE))) ?? ''
  const system = systemOf(text)
  const current = await currentOverviewText(analysisPath, which, text, system)
  const base = baselinePath(which, system)
  if (current === undefined || base === undefined) return { ok: false, reason: 'invalid', message: 'No such overview.' }
  if (current !== expectedText) return { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' }
  const path = join(analysisPath, base)
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, current)
  return { ok: true }
}

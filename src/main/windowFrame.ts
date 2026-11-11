// Where the views sit in the window, and the set of open analyses saved for the next launch.
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { EMPTY_SET } from '../core/analysisSet.ts'
import type { AnalysisSet } from '../core/analysisSet.ts'
import { parseSavedSet } from '../core/savedSet.ts'
import { frameFor } from '../core/windowLayout.ts'
import { allContexts, windowState } from './windowState.ts'

const savedSetPath = () => join(app.getPath('userData'), 'open-analyses.json')

export async function readSavedSet(): Promise<AnalysisSet> {
  try {
    return parseSavedSet(await readFile(savedSetPath(), 'utf8'))
  } catch {
    return EMPTY_SET
  }
}

function saveSet(set: AnalysisSet) {
  const temp = `${savedSetPath()}.${randomUUID()}.tmp`
  void writeFile(temp, JSON.stringify(set))
    .then(() => rename(temp, savedSetPath()))
    .catch((err: unknown) => {
      console.error('Could not save the open analyses', err)
    })
}

/** Puts every view and the strip where the window's size and the strip's settings say. */
export function layout() {
  const host = windowState.host
  if (!host) return
  const { strip, views } = frameFor(host.win.getContentBounds(), host.stripPrefs, host.set.paths.length)
  host.strip.setVisible(strip !== undefined)
  for (const ctx of allContexts()) ctx.view.setBounds(views)
  if (strip) host.strip.setBounds(strip)
}

/** Takes the new set of open analyses, saves it unless the window is closing, and lays out when the count changed. */
export function setSet(next: AnalysisSet) {
  const host = windowState.host
  if (!host) return
  const count = host.set.paths.length
  host.set = next
  if (!host.closingAll) saveSet(next)
  // Auto-hide shows the strip only from the second analysis on.
  if (count !== next.paths.length) layout()
}

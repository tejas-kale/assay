// The app's settings file, in Electron's per-user data folder. Written by temp file and rename,
// like the analysis files.
import { app, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { normalizeRoot, parseSettings, rootFor, serializeSettings } from '../core/settings.ts'
import type { SetRootResult } from '../shared/ipc.ts'

const settingsPath = () => join(app.getPath('userData'), 'settings.json')

/** The folder holding `analyses/`, or undefined until the user sets it. */
export async function analysisRoot(): Promise<string | undefined> {
  const text = await readFile(settingsPath(), 'utf8').catch(() => undefined)
  const { root } = parseSettings(text)
  // A root saved before rootFor existed may be an analysis folder itself.
  return root && rootFor(root)
}

export async function saveRoot(input: string): Promise<SetRootResult> {
  const result = normalizeRoot(input, homedir())
  if (!result.ok) return result
  const info = await stat(result.path).catch(() => undefined)
  if (!info?.isDirectory()) return { ok: false, message: `No such folder: ${result.path}` }
  const temp = `${settingsPath()}.${randomUUID()}.tmp`
  await writeFile(temp, serializeSettings({ root: result.path }))
  await rename(temp, settingsPath())
  return { ok: true, root: result.path }
}

export async function chooseRootPath(win: BrowserWindow): Promise<string | undefined> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return canceled ? undefined : filePaths[0]
}

// The app's settings file, in Electron's per-user data folder. Written by temp file and rename,
// like the analysis files.
import { app, dialog } from 'electron'
import type { BaseWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { normalizeRoot, parseSettings, rootFor, serializeSettings } from '../core/settings.ts'
import type { Settings } from '../core/settings.ts'
import { parseStripPrefs } from '../core/strip.ts'
import { parseTabPrefs } from '../core/tabs.ts'
import type { SetRootResult } from '../shared/ipc.ts'

const settingsPath = () => join(app.getPath('userData'), 'settings.json')
/** Where the strip's side lived before settings.json held it (docs/slice-11.md, 11e). */
const legacyStripPath = () => join(app.getPath('userData'), 'strip.json')

const readOptional = (path: string) => readFile(path, 'utf8').catch(() => undefined)

async function write(settings: Settings) {
  const temp = `${settingsPath()}.${randomUUID()}.tmp`
  await writeFile(temp, serializeSettings(settings))
  await rename(temp, settingsPath())
}

// Every read-modify-write runs after the one before, so two quick changes cannot drop each other.
let queue: Promise<unknown> = Promise.resolve()

function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task)
  queue = next.catch(() => undefined)
  return next
}

/** Reads settings.json. An old strip.json moves into it once and is deleted. */
async function load(): Promise<Settings> {
  const [text, legacy] = await Promise.all([readOptional(settingsPath()), readOptional(legacyStripPath())])
  const settings = parseSettings(text, legacy)
  if (legacy !== undefined) {
    await write(settings)
    await unlink(legacyStripPath()).catch(() => undefined)
  }
  return settings
}

export const readSettings = (): Promise<Settings> => serially(load)

/** Applies `change` to the saved settings and saves the result. */
export const updateSettings = (change: (settings: Settings) => Settings): Promise<Settings> =>
  serially(async () => {
    const next = change(await load())
    await write(next)
    return next
  })

/** The folder holding `analyses/`, or undefined until the user sets it. */
export async function analysisRoot(): Promise<string | undefined> {
  const { root } = await readSettings()
  // A root saved before rootFor existed may be an analysis folder itself.
  return root && rootFor(root)
}

export async function saveRoot(input: string): Promise<SetRootResult> {
  const result = normalizeRoot(input, homedir())
  if (!result.ok) return result
  const info = await stat(result.path).catch(() => undefined)
  if (!info?.isDirectory()) return { ok: false, message: `No such folder: ${result.path}` }
  await updateSettings(settings => ({ ...settings, root: result.path }))
  return { ok: true, root: result.path }
}

/** Saves the tab settings the renderer sent, cleaned as a file read would be. */
export const saveTabs = (raw: unknown): Promise<Settings> => updateSettings(settings => ({ ...settings, tabs: parseTabPrefs(raw) }))

/** Saves the strip settings the renderer sent, cleaned as a file read would be. */
export const saveStrip = (raw: unknown): Promise<Settings> => updateSettings(settings => ({ ...settings, strip: parseStripPrefs(raw) }))

export async function chooseRootPath(win: BaseWindow): Promise<string | undefined> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return canceled ? undefined : filePaths[0]
}

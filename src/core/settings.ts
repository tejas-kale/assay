import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

import { parseStripPrefs } from './strip.ts'
import type { StripPrefs } from './strip.ts'
import { parseTabPrefs } from './tabs.ts'
import type { TabPrefs } from './tabs.ts'

/** The app's settings. There is no default root: until one is set, the app asks for it. */
export type Settings = { root?: string; tabs: TabPrefs; strip: StripPrefs }

function parseJson(text: string | undefined): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    return undefined
  }
}

const field = (object: unknown, key: string): unknown => (object !== null && typeof object === 'object' ? Reflect.get(object, key) : undefined)

/**
 * settings.json, with defaults for anything missing or malformed. `legacyStrip` is the old `strip.json`: its side
 * counts only while settings.json has no `strip` of its own (main then saves the result and deletes the old file).
 */
export function parseSettings(text: string | undefined, legacyStrip?: string): Settings {
  const raw = parseJson(text)
  const root = field(raw, 'root')
  const strip = field(raw, 'strip') ?? { side: field(parseJson(legacyStrip), 'side') }
  return { ...(typeof root === 'string' && root !== '' && { root }), tabs: parseTabPrefs(field(raw, 'tabs')), strip: parseStripPrefs(strip) }
}

export const serializeSettings = (settings: Settings) => `${JSON.stringify(settings, null, 2)}\n`

export type RootResult = { ok: true; path: string } | { ok: false; message: string }

/** What the user typed as a folder, as an absolute path. Does not touch the disk. */
export function normalizeRoot(input: string, home: string): RootResult {
  const text = input.trim()
  if (text === '') return { ok: false, message: 'Enter a folder.' }
  const expanded = text === '~' || text.startsWith('~/') ? join(home, text.slice(1)) : text
  if (!isAbsolute(expanded)) return { ok: false, message: 'Use a full path, starting with / or ~/.' }
  const path = normalize(expanded)
  return { ok: true, path: rootFor(path.length > 1 ? path.replace(/\/+$/, '') : path) }
}

/** The folder holding `analyses/`, given a path the user picked. Picking `analyses/` itself or one analysis inside it means its root. */
export function rootFor(path: string): string {
  if (basename(path) === 'analyses') return dirname(path)
  if (basename(dirname(path)) === 'analyses') return dirname(dirname(path))
  return path
}

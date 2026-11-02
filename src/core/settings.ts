import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

/** The app's settings. There is no default root: until one is set, the app asks for it. */
export type Settings = { root?: string }

export function parseSettings(text: string | undefined): Settings {
  if (!text) return {}
  try {
    const root: unknown = (JSON.parse(text) as { root?: unknown } | null)?.root
    return typeof root === 'string' && root !== '' ? { root } : {}
  } catch {
    return {}
  }
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

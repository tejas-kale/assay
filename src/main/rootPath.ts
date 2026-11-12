// The folder the user picked as the root, checked on the disk. No Electron here, so the tests run it on a temp folder.
import { realpath, stat } from 'node:fs/promises'

import { normalizeRoot } from '../core/settings.ts'
import type { RootResult } from '../core/settings.ts'

/**
 * The real path of the folder the user typed or picked, or why it cannot be the root. The text check in
 * `normalizeRoot` runs on the typed path and again on the real one, against the real home, so a link to the home
 * folder or above it is refused. It runs a second time in lower case: the Mac's disk ignores case by default, so
 * `/Users/ME` is the home folder (audit UI-5). The real path is what is saved, never the alias.
 */
export async function resolveRoot(input: string, home: string): Promise<RootResult> {
  const typed = normalizeRoot(input, home)
  if (!typed.ok) return typed
  const real = await realpath(typed.path).catch(() => undefined)
  if (real === undefined || !(await stat(real)).isDirectory()) return { ok: false, message: `No such folder: ${typed.path}` }
  const realHome = await realpath(home).catch(() => home)
  // A link to an analyses/ folder is its root too, as for a typed one.
  const resolved = normalizeRoot(real, realHome)
  const lowered = normalizeRoot(real.toLowerCase(), realHome.toLowerCase())
  if (!resolved.ok) return resolved
  if (!lowered.ok) return { ok: false, message: `${resolved.path} holds your home folder (the disk ignores case): pick the folder that holds analyses/.` }
  return resolved
}

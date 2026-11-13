// The `assay` terminal command: a two-line launcher, beside the user's other commands, that runs the CLI inside the
// installed app. The app writes it at each launch (runtime.ts) and `npm run install-cli` writes it from a checkout.
// No shell is involved in the launch.
import { access, chmod, constants, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

// Unchanged since the first launchers: it is how an existing one is recognised as Assay's.
const MARKER = '#!/bin/sh\n# Assay terminal launcher (managed by install-cli.mjs)\n'

async function writable(folder: string) {
  try {
    await mkdir(folder, { recursive: true })
    await access(folder, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The first writable command folder on PATH, from those a user's own commands usually live in. */
async function commandFolder(path: string, home: string) {
  const onPath = path.split(delimiter)
  for (const folder of [join(home, '.local/bin'), join(home, 'bin'), '/usr/local/bin']) {
    if (onPath.includes(folder) && (await writable(folder))) return folder
  }
  throw new Error('No writable command folder on PATH. Create ~/.local/bin, add it to PATH, then install again.')
}

/**
 * Writes the launcher for the CLI at `entry`, or leaves it when it already runs that entry. A file of the same name
 * that is not Assay's launcher is never replaced.
 */
export async function installLauncher({ entry, path, home }: { entry: string; path: string; home: string }): Promise<{ state: 'installed' | 'current'; target: string }> {
  const target = join(await commandFolder(path, home), 'assay')
  const text = `${MARKER}exec node ${entry} "$@"\n`
  const existing = await lstat(target).catch(() => undefined)
  const current = existing?.isFile() ? await readFile(target, 'utf8') : undefined
  if (existing && !current?.startsWith(MARKER)) throw new Error(`${target} already exists and is not Assay's launcher. Move it aside before installing.`)
  if (current === text) return { state: 'current', target }
  await writeFile(target, text, { mode: 0o755, flag: existing ? 'w' : 'wx' })
  await chmod(target, 0o755)
  return { state: 'installed', target }
}

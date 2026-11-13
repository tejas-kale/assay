// Install the terminal entry beside other user commands; no shell is involved in the launch.
import { access, chmod, constants, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

// The launcher runs the CLI inside the installed app, whichever build that is (a GitHub release or install-app's).
const entry = '/Applications/Assay.app/Contents/Resources/backend/out/cli/assay.mjs'
const path = (process.env.PATH ?? '').split(delimiter)
const candidates = [join(homedir(), '.local/bin'), join(homedir(), 'bin'), '/usr/local/bin'].filter(candidate => path.includes(candidate))
async function writable(candidate) {
  try {
    await mkdir(candidate, { recursive: true })
    await access(candidate, constants.W_OK)
    return true
  } catch {
    return false
  }
}
const folder = (await Promise.all(candidates.map(async candidate => await writable(candidate) ? candidate : undefined))).find(Boolean)
if (!folder) throw new Error('No writable command folder on PATH. Create ~/.local/bin, add it to PATH, then run node scripts/install-cli.mjs again.')
const target = join(folder, 'assay')
const marker = '#!/bin/sh\n# Assay terminal launcher (managed by install-cli.mjs)\n'
const existing = await lstat(target).catch(() => undefined)
if (existing && (!existing.isFile() || !(await readFile(target, 'utf8')).startsWith(marker))) {
  throw new Error(`${target} already exists and is not Assay's launcher. Move it aside before installing.`)
}
await writeFile(target, `${marker}exec node ${entry} "$@"\n`, { mode: 0o755, flag: existing ? 'w' : 'wx' })
await chmod(target, 0o755)
console.log(`Installed ${target}`)

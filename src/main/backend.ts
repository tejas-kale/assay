// The backend each version of the app ships (docs/slice-11.md, 11b), installed under the app's data folder at
// launch: the plugin, server, hooks and Python project are copied once per version, and uv builds the venv from
// them. No Electron here, so the tests run it on a temp folder.
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { staleEntries, TEMP_PREFIX } from '../core/backendLayout.ts'
import { parseVenvBuild, venvStatusPath } from '../core/venv.ts'
import type { VenvBuild } from '../core/venv.ts'

const exists = (path: string) => stat(path).then(() => true, () => false)
const randomSuffix = () => randomUUID().slice(0, 8)

/** The file in an installed backend, and in a built venv, that names the shipped content it came from. */
const STAMP = '.assay-stamp'

/** A hash of every file's path and content under a folder: the identity of a shipped backend. */
export async function backendStamp(folder: string): Promise<string> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  const files = entries
    .filter(entry => entry.isFile() && entry.name !== STAMP)
    .map(entry => relative(folder, join(entry.parentPath, entry.name)))
    .sort((a, b) => a.localeCompare(b, 'en'))
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update('\0').update(await readFile(join(folder, file))).update('\0')
  return hash.digest('hex')
}

/** The stamp an installed backend or a built venv was made from; undefined when it has none. */
export const installedStamp = (folder: string) => readFile(join(folder, STAMP), 'utf8').then(text => text.trim(), () => undefined)

/**
 * This version's backend folder, copied from the shipped one when it is missing or holds other content: every local
 * build is the same version, so the version alone cannot tell two builds apart. The copy is hashed again at each
 * launch, not trusted by its stamp: its hooks and server enforce Assay's rules, and anything running as the user
 * could edit them, where the shipped copy is sealed by the app's signature. The copy goes to a temporary folder
 * beside it and is renamed into place, so a crash mid-copy never leaves a backend that looks installed.
 */
export async function installBackend({ shipped, home, version }: { shipped: string; home: string; version: string }): Promise<string> {
  const target = join(home, 'backend', version)
  const stamp = await backendStamp(shipped)
  const installed = await exists(target) ? await backendStamp(target).catch(() => undefined) : undefined
  if (installed === stamp && (await installedStamp(target)) === stamp) return target
  await mkdir(join(home, 'backend'), { recursive: true })
  const temporary = join(home, 'backend', `${TEMP_PREFIX}${version}-${randomSuffix()}`)
  await cp(shipped, temporary, { recursive: true })
  await writeFile(join(temporary, STAMP), `${stamp}\n`, 'utf8')
  // The old copy moves aside under the temporary prefix, so pruning removes it if this launch crashes before rm.
  const old = join(home, 'backend', `${TEMP_PREFIX}old-${version}-${randomSuffix()}`)
  if (await exists(target)) await rename(target, old).catch(() => undefined)
  try {
    await rename(temporary, target)
  } catch (error) {
    // Another instance of the same build won the rename: its copy is as good as this one.
    await rm(temporary, { recursive: true, force: true })
    if ((await installedStamp(target)) !== stamp) throw error
  }
  await rm(old, { recursive: true, force: true })
  return target
}

/** Deletes the backend and venv folders of versions other than this one and the one before it. */
export async function pruneVersions(home: string, version: string): Promise<void> {
  for (const folder of [join(home, 'backend'), join(home, 'venvs')]) {
    const names = await readdir(folder).catch(() => [])
    await Promise.all(staleEntries(names, version).map(name => rm(join(folder, name), { recursive: true, force: true })))
  }
}

/** Runs uv with these arguments and environment additions; an error is uv's own message. */
export type UvRun = (args: readonly string[], env: Record<string, string>) => Promise<{ error?: string }>

export type VenvOptions = {
  /** The Python project (`<backend>/python`). */
  project: string
  venv: string
  runUv: UvRun
  onState?: (build: VenvBuild) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function writeStatus(venv: string, build: VenvBuild) {
  const path = venvStatusPath(venv)
  const temporary = `${path}.${randomSuffix()}`
  await writeFile(temporary, `${JSON.stringify(build)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * `uv sync` into the venv, its state written beside it for the server (`<venv>.status.json`). Every failure, uv's or
 * the file system's, comes back as the failed state, never as an exception: the Doctor shows it and Recheck retries.
 */
async function syncVenv({ project, venv, runUv, onState }: VenvOptions, flags: readonly string[]): Promise<VenvBuild> {
  const settle = async (build: VenvBuild) => {
    await writeStatus(venv, build).catch(() => undefined)
    onState?.(build)
    return build
  }
  try {
    await mkdir(dirname(venv), { recursive: true })
    await writeStatus(venv, { state: 'building' })
    onState?.({ state: 'building' })
    const ran = await runUv(['sync', '--frozen', ...flags, '--project', project], { UV_PROJECT_ENVIRONMENT: venv })
    return await settle(ran.error === undefined ? { state: 'ready' } : { state: 'failed', error: ran.error })
  } catch (error) {
    return settle({ state: 'failed', error: messageOf(error) })
  }
}

/**
 * A backend's venv, built once: the project installs into it non-editable, so it holds that backend's helpers. A
 * venv built from other content (`stamp`, the backend's) is deleted and built again.
 */
export async function buildReleaseVenv(options: VenvOptions & { stamp: string }): Promise<VenvBuild> {
  const current = parseVenvBuild(await readFile(venvStatusPath(options.venv), 'utf8').catch(() => undefined))
  const sameBackend = (await installedStamp(options.venv)) === options.stamp
  if (current?.state === 'ready' && sameBackend && (await exists(join(options.venv, 'bin/python')))) {
    options.onState?.(current)
    return current
  }
  if (!sameBackend) await rm(options.venv, { recursive: true, force: true }).catch(() => undefined)
  // The dev group (pytest-cov, ruff) is for the repo's own checks, not the app's venv.
  const built = await syncVenv(options, ['--no-editable', '--no-dev'])
  if (built.state === 'ready') await writeFile(join(options.venv, STAMP), `${options.stamp}\n`, 'utf8').catch(() => undefined)
  return built
}

/** The dev venv, synced editable at every launch, so edits to python/ and a changed uv.lock reach it. */
export const syncDevVenv = (options: VenvOptions): Promise<VenvBuild> => syncVenv(options, [])

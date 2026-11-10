// The backend each version of the app ships (docs/slice-11.md, 11b), installed under the app's data folder at
// launch: the plugin, server, hooks and Python project are copied once per version, and uv builds the venv from
// them. No Electron here, so the tests run it on a temp folder.
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { staleEntries, TEMP_PREFIX } from '../core/backendLayout.ts'
import { parseVenvBuild, venvStatusPath } from '../core/venv.ts'
import type { VenvBuild } from '../core/venv.ts'

const exists = (path: string) => stat(path).then(() => true, () => false)
const randomSuffix = () => randomUUID().slice(0, 8)

/**
 * This version's backend folder, copied from the shipped one when it is missing. The copy goes to a temporary folder
 * beside it and is renamed into place, so a crash mid-copy never leaves a backend that looks installed.
 */
export async function installBackend({ shipped, home, version }: { shipped: string; home: string; version: string }): Promise<string> {
  const target = join(home, 'backend', version)
  if (await exists(target)) return target
  await mkdir(join(home, 'backend'), { recursive: true })
  const temporary = join(home, 'backend', `${TEMP_PREFIX}${version}-${randomSuffix()}`)
  await cp(shipped, temporary, { recursive: true })
  try {
    await rename(temporary, target)
  } catch (error) {
    // Another instance of the same version won the rename: its copy is as good as this one.
    await rm(temporary, { recursive: true, force: true })
    if (!(await exists(target))) throw error
  }
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
  /** The dev venv installs the helpers editable, so edits to python/ apply at once; a version's never does. */
  isEditable: boolean
  runUv: UvRun
  onState?: (build: VenvBuild) => void
}

async function writeStatus(venv: string, build: VenvBuild) {
  const path = venvStatusPath(venv)
  const temporary = `${path}.${randomSuffix()}`
  await writeFile(temporary, `${JSON.stringify(build)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Builds the venv with `uv sync` unless this version's is already built, writing its state beside it for the server
 * (`<venv>.status.json`). A version's venv holds that version's helpers, so it is built once; the dev venv syncs at
 * every launch, so a changed uv.lock reaches it (uv's cache makes an unchanged one take a second).
 */
export async function buildVenv({ project, venv, isEditable, runUv, onState }: VenvOptions): Promise<VenvBuild> {
  const current = parseVenvBuild(await readFile(venvStatusPath(venv), 'utf8').catch(() => undefined))
  if (!isEditable && current?.state === 'ready' && (await exists(join(venv, 'bin/python')))) {
    onState?.(current)
    return current
  }
  const set = async (build: VenvBuild) => {
    await writeStatus(venv, build)
    onState?.(build)
    return build
  }
  await mkdir(join(venv, '..'), { recursive: true })
  await set({ state: 'building' })
  const args = ['sync', '--frozen', ...(isEditable ? [] : ['--no-editable']), '--project', project]
  const ran = await runUv(args, { UV_PROJECT_ENVIRONMENT: venv }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
  return set(ran.error === undefined ? { state: 'ready' } : { state: 'failed', error: ran.error })
}

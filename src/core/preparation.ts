// What the app does about its backend at launch and on Recheck (docs/slice-11.md, 11b), as decisions on its state:
// which line it shows while it prepares, and when a venv build may start.
import type { VenvBuild } from './venv.ts'

export type Preparation = {
  version: string
  /** The shipped backend is being copied into place. */
  isInstalling: boolean
  /** The venv's last known state; undefined before the first build reports. */
  venv: VenvBuild | undefined
}

/** The line the app shows while it prepares this version, or undefined when it is not preparing. */
export function preparingNow({ version, isInstalling, venv }: Preparation): string | undefined {
  if (isInstalling) return `Preparing Assay ${version}: copying the backend...`
  if (venv?.state === 'building') return `Preparing Assay ${version}: Python environment...`
  return undefined
}

/**
 * Whether to start building the venv: at launch, and again after a failure (Recheck), but never while a build runs.
 * A built venv is left alone.
 */
export const mayStartVenvBuild = ({ venv, isBuilding }: { venv: VenvBuild | undefined; isBuilding: boolean }) => !isBuilding && venv?.state !== 'ready'

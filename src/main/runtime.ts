// The backend this launch runs and the Doctor's view of the user's tools. At launch, before any analysis starts
// Claude, the shipped backend is installed for this version; the venv builds in the background, and Claude may
// start meanwhile (a Python tool called early answers that the venv is still building).
import { app } from 'electron'
import { join } from 'node:path'

import { preparingLine } from '../core/backendLayout.ts'
import { blocksOpening, doctorChecks } from '../core/doctor.ts'
import type { Check, Probes } from '../core/doctor.ts'
import type { VenvBuild } from '../core/venv.ts'
import type { DoctorView } from '../shared/ipc.ts'
import { buildVenv, installBackend, pruneVersions } from './backend.ts'
import { loginPath, probeTools, uvWith } from './doctor.ts'

/** Where Claude finds the backend and the tools' venv (docs/process/launch-contract.md). */
export type LaunchPaths = { backend: string; venv: string }

type State = { preparing?: string; error?: string; venv?: VenvBuild; probes?: Probes; isChecking: boolean }

const state: State = { isChecking: false }
const listeners: ((view: DoctorView) => void)[] = []
let paths: Promise<LaunchPaths> | undefined
let venvBuild: Promise<VenvBuild> | undefined

const version = () => (app.isPackaged ? app.getVersion() : 'dev')

function changed() {
  const view = doctorView()
  for (const listener of listeners) listener(view)
}

export function onDoctorChange(listener: (view: DoctorView) => void) {
  listeners.push(listener)
}

export function doctorView(): DoctorView {
  const checks: Check[] = state.probes ? doctorChecks({ probes: state.probes, venv: state.venv, ...(process.env.ASSAY_CLAUDE_BIN ? { claudeBin: process.env.ASSAY_CLAUDE_BIN } : {}) }) : []
  return {
    version: app.isPackaged ? app.getVersion() : `${app.getVersion()} (dev)`,
    checks,
    isChecking: state.isChecking,
    ...(state.preparing ? { preparing: state.preparing } : {}),
    ...(state.error ? { error: state.error } : {}),
  }
}

/**
 * Packaged, the backend is Resources/backend copied to backend/<version>; unpackaged (`npm run dev`) it is the repo
 * itself, after `npm run build:server`, with an editable venv in venvs/dev.
 */
async function install(): Promise<LaunchPaths> {
  const home = app.getPath('userData')
  const venv = join(home, 'venvs', version())
  if (!app.isPackaged) return { backend: app.getAppPath(), venv }
  state.preparing = preparingLine(version(), 'backend')
  changed()
  const backend = await installBackend({ shipped: join(process.resourcesPath, 'backend'), home, version: version() })
  await pruneVersions(home, version()).catch(() => undefined)
  return { backend, venv }
}

/** Builds the venv once at a time; a failed build is tried again by the next call (Recheck). */
function startVenvBuild(launch: LaunchPaths, path: Promise<string>): Promise<VenvBuild> {
  if (venvBuild && state.venv?.state !== 'failed') return venvBuild
  state.preparing = preparingLine(version(), 'venv')
  venvBuild = path.then(async loginShellPath =>
    buildVenv({
      project: join(launch.backend, 'python'),
      venv: launch.venv,
      isEditable: !app.isPackaged,
      runUv: uvWith(loginShellPath),
      onState: build => {
        state.venv = build
        if (build.state !== 'building') state.preparing = undefined
        changed()
      },
    }),
  )
  return venvBuild
}

async function check(path: Promise<string>) {
  state.isChecking = true
  changed()
  state.probes = await probeTools(await path)
  state.isChecking = false
  changed()
}

/** At launch: installs this version's backend, then builds its venv and checks the tools, both in the background. */
export function prepareBackend(): Promise<LaunchPaths> {
  paths ??= install().catch((error: unknown) => {
    state.error = `Could not install Assay's backend: ${error instanceof Error ? error.message : String(error)}`
    state.preparing = undefined
    changed()
    throw error
  })
  const path = loginPath()
  void paths.then(launch => startVenvBuild(launch, path), () => undefined)
  void check(path)
  return paths
}

/** The Doctor's Recheck: the tools again, and the venv build again when it failed. */
export async function recheck(): Promise<DoctorView> {
  const path = loginPath()
  if (paths && state.venv?.state === 'failed') void paths.then(launch => startVenvBuild(launch, path), () => undefined)
  await check(path)
  return doctorView()
}

/** The paths Claude starts with, once the backend is installed. */
export const launchPaths = (): Promise<LaunchPaths> => paths ?? prepareBackend()

/** Why an analysis cannot open now, or undefined: only a Claude that is known to be missing stops it. */
export function openBlocker(): string | undefined {
  const checks = doctorView().checks
  return blocksOpening(checks) ? `${checks[0]?.name ?? 'claude'} is not on your login shell's PATH. Open Settings (⌘,) and see the Doctor.` : undefined
}

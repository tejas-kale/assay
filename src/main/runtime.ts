// The backend this launch runs and the Doctor's view of the user's tools. At launch, before any analysis starts
// Claude, the shipped backend is installed for this version; the venv builds in the background, and Claude may
// start meanwhile (a Python tool called early answers that the venv is still building). The decisions are in
// core/preparation.ts; this module holds the state and runs them.
import { app } from 'electron'
import { join } from 'node:path'

import { blocksOpening, doctorChecks } from '../core/doctor.ts'
import type { Check, LoginEnv, Probes } from '../core/doctor.ts'
import { mayStartVenvBuild, preparingNow } from '../core/preparation.ts'
import type { VenvBuild } from '../core/venv.ts'
import type { DoctorView } from '../shared/ipc.ts'
import { buildReleaseVenv, installBackend, installedStamp, pruneVersions, syncDevVenv } from './backend.ts'
import type { VenvOptions } from './backend.ts'
import { loginEnv, probeTools, uvWith } from './doctor.ts'

/** Where Claude finds the backend and the tools' venv (docs/developer/launch-contract.md). */
export type LaunchPaths = { backend: string; venv: string }

type State = { isInstalling: boolean; isBuilding: boolean; isChecking: boolean; installError?: string; venv?: VenvBuild; probes?: Probes; claudeBin?: string }

const state: State = { isInstalling: false, isBuilding: false, isChecking: false }
const listeners: ((view: DoctorView) => void)[] = []
let paths: Promise<LaunchPaths> | undefined

const version = () => (app.isPackaged ? app.getVersion() : 'dev')

function changed() {
  const view = doctorView()
  for (const listener of listeners) listener(view)
}

export function onDoctorChange(listener: (view: DoctorView) => void) {
  listeners.push(listener)
}

export function doctorView(): DoctorView {
  const checks: Check[] = state.probes ? doctorChecks({ probes: state.probes, venv: state.venv, ...(state.claudeBin ? { claudeBin: state.claudeBin } : {}) }) : []
  const preparing = preparingNow({ version: version(), isInstalling: state.isInstalling, venv: state.venv })
  return {
    version: app.isPackaged ? app.getVersion() : `${app.getVersion()} (dev)`,
    checks,
    isChecking: state.isChecking,
    ...(preparing ? { preparing } : {}),
    ...(state.installError ? { error: state.installError } : {}),
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
  state.isInstalling = true
  changed()
  try {
    const backend = await installBackend({ shipped: join(process.resourcesPath, 'backend'), home, version: version() })
    await pruneVersions(home, version()).catch(() => undefined)
    return { backend, venv }
  } finally {
    state.isInstalling = false
    changed()
  }
}

/** Starts a venv build when core allows it (at launch, or after a failure). The build itself never throws. */
async function buildVenvIfDue(launch: LaunchPaths, login: Promise<LoginEnv & { PATH: string }>) {
  if (!mayStartVenvBuild({ venv: state.venv, isBuilding: state.isBuilding })) return
  state.isBuilding = true
  const options: VenvOptions = {
    project: join(launch.backend, 'python'),
    venv: launch.venv,
    runUv: uvWith((await login).PATH),
    onState: build => {
      state.venv = build
      changed()
    },
  }
  // A packaged backend always has its stamp; a missing one rebuilds the venv rather than trusting it.
  await (app.isPackaged ? buildReleaseVenv({ ...options, stamp: (await installedStamp(launch.backend)) ?? 'none' }) : syncDevVenv(options))
  state.isBuilding = false
  changed()
}

async function checkTools(login: Promise<LoginEnv>) {
  state.isChecking = true
  changed()
  const env = await login
  state.claudeBin = env.ASSAY_CLAUDE_BIN
  state.probes = await probeTools(env)
  state.isChecking = false
  changed()
}

/** The login environment, then the venv build when it is due and the tools' checks, both in the background. */
function backgroundWork() {
  const login = loginEnv()
  void paths?.then(launch => buildVenvIfDue(launch, login), () => undefined)
  return checkTools(login)
}

/** At launch: installs this version's backend, then builds its venv and checks the tools. */
export function prepareBackend(): Promise<LaunchPaths> {
  if (paths) return paths
  paths = install().catch((error: unknown) => {
    state.installError = `Could not install Assay's backend: ${error instanceof Error ? error.message : String(error)}`
    changed()
    throw error
  })
  void backgroundWork()
  return paths
}

/** The Doctor's Recheck: the tools again, and the venv build again when it failed. */
export async function recheck(): Promise<DoctorView> {
  await backgroundWork()
  return doctorView()
}

/** The paths Claude starts with, once the backend is installed. */
export const launchPaths = (): Promise<LaunchPaths> => prepareBackend()

/** Why an analysis cannot open now, or undefined: only a Claude that is known to be missing stops it. */
export function openBlocker(): string | undefined {
  const checks = doctorView().checks
  return blocksOpening(checks) ? `${checks[0]?.name ?? 'claude'} is not on your login shell's PATH. Open Settings (⌘,) and see the Doctor.` : undefined
}

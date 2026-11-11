// Auto-update (docs/slice-11.md, 11d): electron-updater checks the private GitHub releases with the user's
// fine-grained token, downloads in the background, and installs at the next restart or quit. The decisions (state,
// banner, when to check) are in core/update.ts; this module holds the state, the token and the updater.
//
// The token is encrypted with safeStorage (the Keychain) into userData/update-token.bin and never leaves main: the
// renderer only learns whether one is kept.
import { app, safeStorage } from 'electron'
import updater from 'electron-updater'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { checkToken, initialUpdate, isCheckDue, nextCheckAt, updateOn } from '../core/update.ts'
import type { UpdateEvent, UpdateState } from '../core/update.ts'
import type { SetTokenResult, UpdateView } from '../shared/ipc.ts'

const { autoUpdater } = updater

/** As in package.json's build.publish, where the releases are. */
const FEED = { provider: 'github', owner: 'tejas-kale', repo: 'assay', private: true } as const
const TICK_MS = 60_000
const MAX_ERROR = 300

const launchedAt = Date.now()
let state: UpdateState = initialUpdate({ current: app.getVersion(), hasToken: false })
let hasToken = false
const listeners: ((view: UpdateView) => void)[] = []
let onRestart: (() => void) | undefined

const tokenPath = () => join(app.getPath('userData'), 'update-token.bin')

export function updateView(): UpdateView {
  return { ...state, hasToken, isPackaged: app.isPackaged }
}

export function onUpdateChange(listener: (view: UpdateView) => void) {
  listeners.push(listener)
}

function dispatch(event: UpdateEvent) {
  state = updateOn(state, event)
  const view = updateView()
  for (const listener of listeners) listener(view)
}

/** An updater error's first line, cut short: a GitHub HTTP error carries the whole response after it. */
const errorLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, MAX_ERROR) ?? ''

async function readToken(): Promise<string | undefined> {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  const bytes = await readFile(tokenPath()).catch(() => undefined)
  if (!bytes) return undefined
  try {
    return safeStorage.decryptString(bytes)
  } catch {
    return undefined
  }
}

/** Points the updater at the releases with this token; electron-updater sends it on every request. */
function useToken(token: string) {
  autoUpdater.setFeedURL({ ...FEED, token })
  hasToken = true
  dispatch({ type: 'token', isSet: true })
}

export async function saveToken(input: string): Promise<SetTokenResult> {
  const checked = checkToken(input)
  if (!checked.ok) return checked
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'The Keychain is not available, so the token cannot be kept.' }
  const temp = `${tokenPath()}.${randomUUID()}.tmp`
  await writeFile(temp, safeStorage.encryptString(checked.token), { mode: 0o600 })
  await rename(temp, tokenPath())
  useToken(checked.token)
  return { ok: true }
}

export async function clearToken(): Promise<UpdateView> {
  await rm(tokenPath(), { force: true })
  hasToken = false
  dispatch({ type: 'token', isSet: false })
  return updateView()
}

function check() {
  if (!isCheckDue(state, { launchedAt, now: Date.now() })) return
  dispatch({ type: 'checking', at: Date.now() })
  // A failed check also fires 'error', which records it.
  autoUpdater.checkForUpdates().catch((error: unknown) => {
    dispatch({ type: 'error', message: errorLine(error) })
  })
}

/** At launch, packaged builds only: reads the token, wires the updater's events, and checks on schedule. */
export async function startUpdater() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', info => {
    dispatch({ type: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    dispatch({ type: 'not-available' })
  })
  autoUpdater.on('update-downloaded', info => {
    dispatch({ type: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', error => {
    dispatch({ type: 'error', message: errorLine(error) })
  })
  const token = await readToken()
  if (token) useToken(token)
  setInterval(check, TICK_MS)
  setTimeout(check, Math.max(0, nextCheckAt(state, { launchedAt }) - Date.now()))
}

/** Set by index.ts, which owns the quit flow: close every analysis, then call installAndRelaunch. */
export const setOnRestart = (cb: () => void) => {
  onRestart = cb
}

/** The banner's Restart and the palette's Restart to update. */
export function requestRestart() {
  if (state.ready !== undefined) onRestart?.()
}

/** Once every analysis has closed: installs the downloaded update and relaunches the app. */
export function installAndRelaunch() {
  autoUpdater.quitAndInstall()
}

// Auto-update (docs/slice-11.md, 11d): electron-updater checks the private GitHub releases with the user's
// fine-grained token, downloads in the background, and installs at the next restart or quit. The decisions (state,
// banner, when to check) are in core/update.ts; this module holds the state, the token and the updater.
//
// The token is encrypted with safeStorage (the Keychain) into userData/update-token.bin and never leaves main: the
// renderer only learns whether one is kept.
import { app, autoUpdater as nativeUpdater, safeStorage } from 'electron'
import updater from 'electron-updater'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { checkToken, initialUpdate, isCheckDue, nextCheckAt, updateOn, UPDATER_OPTIONS } from '../core/update.ts'
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

type TokenRead = { token: string } | { isMissing: true } | { error: string }

const UNREADABLE = 'The saved token could not be read from the Keychain. Paste it again.'

/** The saved token, none, or why it cannot be read: a token that is there but unreadable is reported, not ignored. */
async function readToken(): Promise<TokenRead> {
  let bytes: Buffer
  try {
    bytes = await readFile(tokenPath())
  } catch (error) {
    const isMissing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    return isMissing ? { isMissing: true } : { error: `${UNREADABLE} ${errorLine(error)}` }
  }
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(bytes)
    // The Keychain key rotated: saved again under the new one, so the next launch still reads it.
    if (shouldReEncrypt) await writeToken(result)
    return { token: result }
  } catch {
    return { error: UNREADABLE }
  }
}

/**
 * Points the updater at the releases with this token, sent on every request, or turns it off. Without a token, a
 * download that finishes later does not install at quit; one already ready still does.
 */
function setToken(token: string | undefined, error?: string) {
  if (token !== undefined) autoUpdater.setFeedURL({ ...FEED, token })
  hasToken = token !== undefined
  dispatch({ type: 'token', isSet: hasToken, ...(error === undefined ? {} : { error }) })
  autoUpdater.autoInstallOnAppQuit = hasToken || state.status === 'ready'
}

async function writeToken(token: string): Promise<SetTokenResult> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return { ok: false, message: 'The Keychain is not available, so the token cannot be kept.' }
  const temp = `${tokenPath()}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, await safeStorage.encryptStringAsync(token), { mode: 0o600 })
    await rename(temp, tokenPath())
    return { ok: true }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    return { ok: false, message: `Could not save the token: ${errorLine(error)}` }
  }
}

/** Keeps a pasted token and turns the updater on. Every failure is a result, never a rejection. */
export async function saveToken(input: string): Promise<SetTokenResult> {
  const checked = checkToken(input)
  if (!checked.ok) return checked
  const written = await writeToken(checked.token)
  if (written.ok) setToken(checked.token)
  return written
}

/** Forgets the token and turns the updater off; listeners get the new view. */
export async function forgetToken() {
  await rm(tokenPath(), { force: true }).catch(() => undefined)
  setToken(undefined)
}

function check() {
  if (!isCheckDue(state, { launchedAt, now: Date.now() })) return
  dispatch({ type: 'checking', at: Date.now() })
  // A failed check also fires 'error'; recording it twice changes nothing.
  autoUpdater.checkForUpdates().catch((error: unknown) => {
    dispatch({ type: 'error', message: errorLine(error) })
  })
}

function listen() {
  autoUpdater.on('update-available', info => {
    dispatch({ type: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    dispatch({ type: 'not-available' })
  })
  // electron-updater says downloaded before macOS's updater has fetched and checked the zip, which can still fail
  // (its errors come through 'error'). Only macOS's own event means Restart will install.
  nativeUpdater.on('update-downloaded', () => {
    dispatch({ type: 'downloaded' })
  })
  autoUpdater.on('error', error => {
    dispatch({ type: 'error', message: errorLine(error) })
  })
}

/** At launch, packaged builds only: reads the token, wires the updaters' events, and checks on schedule. */
export async function startUpdater() {
  if (!app.isPackaged) return
  Object.assign(autoUpdater, UPDATER_OPTIONS)
  listen()
  const read = await readToken()
  if ('token' in read) setToken(read.token)
  else setToken(undefined, 'error' in read ? read.error : undefined)
  setInterval(check, TICK_MS)
  setTimeout(check, Math.max(0, nextCheckAt(state, { launchedAt }) - Date.now()))
}

/** Set by index.ts, which owns the quit flow: close every analysis, then call installAndRelaunch. */
export const setOnRestart = (cb: () => void) => {
  onRestart = cb
}

/** The banner's Restart and the palette's Restart to update. */
export function requestRestart() {
  if (state.status === 'ready') onRestart?.()
}

/** How long the installer may take to quit the app before the restart counts as failed. */
const INSTALL_MS = 30_000

/**
 * Once every analysis has closed: installs the downloaded update and relaunches. If the app is still running
 * after INSTALL_MS, the update is dropped and `onFailed` reopens the analyses.
 */
export function installAndRelaunch(onFailed: () => void) {
  const fail = () => {
    dispatch({ type: 'install-failed' })
    onFailed()
  }
  const timer = setTimeout(fail, INSTALL_MS)
  try {
    autoUpdater.quitAndInstall()
  } catch {
    clearTimeout(timer)
    fail()
  }
}

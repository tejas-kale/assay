// The updater's state (docs/slice-11.md, 11d): what electron-updater has done, what the banner and Settings say, and
// when the next check is due. Pure; src/main/update.ts feeds it the updater's events and the clock.

export type UpdateStatus = 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

type Common = {
  /** The version running now. */
  current: string
  /** When the last check started, in ms since the epoch. */
  lastCheck?: number
  /** The last failure: a check, a download, an install, or a token that cannot be read. A good check clears it. */
  error?: string
}

export type UpdateState = Common &
  (
    | { status: 'off' | 'idle' | 'checking' | 'error' }
    /** `version` is being downloaded, by electron-updater and then by macOS's updater. */
    | { status: 'downloading'; version: string }
    /** `version` is downloaded and installs at the next restart or quit. */
    | { status: 'ready'; version: string }
  )

/** What the updaters report, as main passes it on. */
export type UpdateEvent =
  /** A token was saved or forgotten; `error` when the saved one cannot be read. */
  | { type: 'token'; isSet: boolean; error?: string }
  | { type: 'checking'; at: number }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  /** macOS's own updater has the download: electron-updater says downloaded before that, and it can still fail. */
  | { type: 'downloaded' }
  | { type: 'error'; message: string }
  /** The installer was called, but the app did not quit. */
  | { type: 'install-failed' }

export function initialUpdate({ current, hasToken }: { current: string; hasToken: boolean }): UpdateState {
  return { status: hasToken ? 'idle' : 'off', current }
}

/** The line Settings > Updates shows under the version. */
export function updateText(state: UpdateState): string {
  switch (state.status) {
    case 'off':
      return 'Updates are off: paste a GitHub token below.'
    case 'idle':
      return 'Up to date.'
    case 'checking':
      return 'Checking for updates...'
    case 'downloading':
      return `Downloading Assay ${state.version}...`
    case 'ready':
      return `Assay ${state.version} installs when you restart or quit.`
    case 'error':
      return 'The last check failed.'
  }
}

const common = ({ current, lastCheck }: UpdateState): Common => ({ current, ...(lastCheck === undefined ? {} : { lastCheck }) })

function onToken(state: UpdateState, event: { isSet: boolean; error?: string }): UpdateState {
  // A downloaded update still installs at quit, token or not.
  if (state.status === 'ready') return state
  return { ...common(state), status: event.isSet ? 'idle' : 'off', ...(event.error === undefined ? {} : { error: event.error }) }
}

/** What the updater reports once a check has started; ignored while off, since a forgotten token ends updates. */
function onUpdater(state: UpdateState, event: Exclude<UpdateEvent, { type: 'token' }>): UpdateState {
  const base = common(state)
  switch (event.type) {
    case 'checking':
      return { ...base, status: 'checking', lastCheck: event.at }
    case 'available':
      return { ...base, status: 'downloading', version: event.version }
    case 'not-available':
      return { ...base, status: 'idle' }
    case 'downloaded':
      return state.status === 'downloading' ? { ...base, status: 'ready', version: state.version } : state
    case 'error':
      // A ready update still installs at the next restart, whatever a later check says.
      return state.status === 'ready' ? { ...state, error: event.message } : { ...base, status: 'error', error: event.message }
    case 'install-failed':
      if (state.status !== 'ready') return state
      return { ...base, status: 'error', error: `Assay ${state.version} did not install. The next check downloads it again.` }
  }
}

export function updateOn(state: UpdateState, event: UpdateEvent): UpdateState {
  if (event.type === 'token') return onToken(state, event)
  return state.status === 'off' ? state : onUpdater(state, event)
}

/** The banner every analysis view shows once an update is downloaded, beside its Restart button. */
export function updateBanner(state: UpdateState): string | undefined {
  return state.status === 'ready' ? `Assay ${state.version} is ready.` : undefined
}

/**
 * The updater's settings that keep an update to the newest signed release. Differential downloads stay off: electron-
 * updater 6 keeps the token's Authorization header when it follows the asset's redirect to the download host.
 */
export const UPDATER_OPTIONS = {
  autoDownload: true,
  allowDowngrade: false,
  allowPrerelease: false,
  disableDifferentialDownload: true,
} as const

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 60 * 60 * 1000

/** When the next check is due: 10 seconds after launch, then an hour after the last one started. */
export function nextCheckAt(state: UpdateState, { launchedAt }: { launchedAt: number }): number {
  return state.lastCheck === undefined ? launchedAt + FIRST_CHECK_MS : state.lastCheck + CHECK_EVERY_MS
}

/** A check runs when it is due and the updater is idle or failed; a download or a waiting install skips it. */
export function isCheckDue(state: UpdateState, clock: { launchedAt: number; now: number }): boolean {
  if (state.status !== 'idle' && state.status !== 'error') return false
  return clock.now >= nextCheckAt(state, clock)
}

export type TokenCheck = { ok: true; token: string } | { ok: false; message: string }

/** A pasted token, trimmed. Only a fine-grained token (scoped to one repo, read-only) is taken. */
export function checkToken(input: string): TokenCheck {
  const token = input.trim()
  if (/^github_pat_\w+$/.test(token)) return { ok: true, token }
  return { ok: false, message: 'Paste a fine-grained token: it starts with github_pat_.' }
}

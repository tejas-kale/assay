// The updater's state (docs/slice-11.md, 11d): what electron-updater has done, what the banner and Settings say, and
// when the next check is due. Pure; src/main/update.ts feeds it the updater's events and the clock.

export type UpdateStatus = 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export type UpdateState = {
  status: UpdateStatus
  /** The version running now. */
  current: string
  /** When the last check started, in ms since the epoch. */
  lastCheck?: number
  /** The version being downloaded. */
  downloading?: string
  /** The version downloaded and installed at the next restart or quit. */
  ready?: string
  /** The last check's or download's error; a later check that succeeds clears it. */
  error?: string
}

/** What electron-updater reports, as main passes it on. */
export type UpdateEvent =
  | { type: 'token'; isSet: boolean }
  | { type: 'checking'; at: number }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

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
      return `Downloading Assay ${state.downloading ?? ''}...`
    case 'ready':
      return `Assay ${state.ready ?? ''} installs when you restart or quit.`
    case 'error':
      return 'The last check failed.'
  }
}

function withoutError(state: UpdateState): UpdateState {
  const { error, ...rest } = state
  return error === undefined ? state : rest
}

export function updateOn(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case 'token':
      // A downloaded update still installs at quit, token or not.
      if (state.ready !== undefined) return state
      return { ...state, status: event.isSet ? 'idle' : 'off' }
    case 'checking':
      return { ...state, status: 'checking', lastCheck: event.at }
    case 'available':
      return { ...state, status: 'downloading', downloading: event.version }
    case 'not-available':
      return withoutError({ ...state, status: 'idle' })
    case 'downloaded':
      return withoutError({ ...state, status: 'ready', ready: event.version })
    case 'error':
      // A downloaded update still installs at the next restart, whatever a later check says.
      return { ...state, status: state.ready === undefined ? 'error' : 'ready', error: event.message }
  }
}

/** The banner every analysis view shows once an update is downloaded, beside its Restart button. */
export function updateBanner(state: UpdateState): string | undefined {
  return state.ready === undefined ? undefined : `Assay ${state.ready} is ready.`
}

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

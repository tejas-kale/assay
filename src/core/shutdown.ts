// How the app ends: Cmd+Q quits, and Restart to update installs and relaunches (docs/slice-11.md, 11d). Both close
// every analysis first, so each Claude exits and a launcher finishes its import, and only then quit or install. The
// open set is not saved while they close, so the next launch reopens it. Pure; src/main/index.ts carries out the
// actions.

/** What ends the app once every analysis has closed. */
export type Finish = 'quit' | 'install'

export type Shutdown =
  | { phase: 'running' }
  /** Waiting for every analysis's session to exit. */
  | { phase: 'closing'; then: Finish }
  /** app.quit or the installer has been called: the quit it causes goes through. */
  | { phase: 'finishing'; then: Finish }

export const RUNNING: Shutdown = { phase: 'running' }

/** `live`: whether any analysis's session still runs. */
export type ShutdownEvent =
  /** Electron's before-quit: Cmd+Q, the Dock, or the installer's own quit. */
  | { type: 'quit'; live: boolean }
  /** The banner's Restart, or the palette's Restart to update. */
  | { type: 'restart'; live: boolean }
  /** An analysis closed, or the window did. */
  | { type: 'closed'; live: boolean }
  /** The installer was called but the app is still running. */
  | { type: 'install-failed' }

/**
 * `allow-quit`: let this before-quit through (any other action on a quit holds it). `close-all`: close every
 * analysis. `quit`, `install`: end the app that way. `reopen`: open the window with the saved analyses again.
 */
export type ShutdownAction = 'none' | 'allow-quit' | 'close-all' | 'quit' | 'install' | 'reopen'

export type ShutdownStep = { state: Shutdown; action: ShutdownAction }

const stay = (state: Shutdown): ShutdownStep => ({ state, action: 'none' })

/** Closing with nothing live finishes at once; with sessions running, every analysis closes first. */
function begin(then: Finish, live: boolean, now: ShutdownAction): ShutdownStep {
  return live ? { state: { phase: 'closing', then }, action: 'close-all' } : { state: { phase: 'finishing', then }, action: now }
}

/** The installer or app.quit was called: let its quit through, and reopen if the install did not quit the app. */
function whileFinishing(state: { phase: 'finishing'; then: Finish }, event: ShutdownEvent): ShutdownStep {
  if (event.type === 'quit') return { state, action: 'allow-quit' }
  if (event.type === 'install-failed' && state.then === 'install') return { state: RUNNING, action: 'reopen' }
  return stay(state)
}

/** Analyses are closing: the latest of Cmd+Q and Restart decides how it ends, once nothing is live. */
function whileClosing(state: { phase: 'closing'; then: Finish }, event: ShutdownEvent): ShutdownStep {
  if (event.type === 'quit') return stay({ phase: 'closing', then: 'quit' })
  if (event.type === 'restart') return stay({ phase: 'closing', then: 'install' })
  if (event.type === 'closed' && !event.live) return { state: { phase: 'finishing', then: state.then }, action: state.then }
  return stay(state)
}

export function shutdownOn(state: Shutdown, event: ShutdownEvent): ShutdownStep {
  if (state.phase === 'finishing') return whileFinishing(state, event)
  if (state.phase === 'closing') return whileClosing(state, event)
  if (event.type === 'quit') return begin('quit', event.live, 'allow-quit')
  if (event.type === 'restart') return begin('install', event.live, 'install')
  return stay(state)
}

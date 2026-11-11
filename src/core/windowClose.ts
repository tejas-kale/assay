// What closing a view does. Pure: main reads the facts and carries the answer out.
import type { CloseState } from './session.ts'

/** What Cmd+W does to a view: close it at once, start its session's graceful close, or ask about forcing it. */
export type CloseAction = 'close-now' | 'start-close' | 'ask-force'

/** `session` is the state of the view's close flow, undefined while it has no session. */
export function closeAction(session: CloseState | undefined): CloseAction {
  if (session === undefined || session === 'exited') return 'close-now'
  return session === 'running' ? 'start-close' : 'ask-force'
}

/** What happens once the window's last view is gone. */
export type AfterLastView = 'end-window' | 'show-picker'

/**
 * Closing everything, or Cmd+W on a picker with nothing open, ends the window; Cmd+W on the last analysis shows the
 * picker.
 */
export function afterLastView(closingAll: boolean, wasPicker: boolean): AfterLastView {
  return closingAll || wasPicker ? 'end-window' : 'show-picker'
}

import type { CloseState, PtyExit } from '../../shared/ipc.ts'

/** The close and ended banners. They sit in the footer, so showing one never resizes the terminal. */
export function Banners({ closeState, exit }: { closeState: CloseState; exit: PtyExit | undefined }) {
  if (closeState === 'closing') {
    return (
      <div className="banner closing" role="status">
        Closing: waiting for the session to finish. Cmd+W asks to force quit.
      </div>
    )
  }
  if (exit) {
    return (
      <div className="banner ended" role="status">
        Session ended (exit {exit.exitCode}). Cmd+W closes the window.
      </div>
    )
  }
  return null
}

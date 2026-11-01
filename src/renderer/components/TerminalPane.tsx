import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { createTerminal } from '../terminal.ts'
import type { TerminalHandle } from '../terminal.ts'

/**
 * Hosts the terminal. No key handlers are attached here or on the element: keys reach the
 * terminal untouched, and Cmd shortcuts are caught in main before they get here.
 */
export function TerminalPane({ handleRef }: { handleRef: RefObject<TerminalHandle | undefined> }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const cleanups: (() => void)[] = []

    void (async () => {
      const terminal = await createTerminal(host)
      if (disposed) {
        terminal.dispose()
        return
      }
      handleRef.current = terminal
      cleanups.push(
        () => {
          handleRef.current = undefined
          terminal.dispose()
        },
        // Subscribe before start so no output is missed. Data is written in arrival order.
        window.app.pty.onData(data => terminal.write(data)),
        terminal.onData(data => window.app.pty.write(data)),
        terminal.onResize((cols, rows) => window.app.pty.resize(cols, rows)),
      )
      const { cols, rows } = terminal.fit()
      await window.app.pty.start(cols, rows)
      if (!disposed) terminal.focus()
    })().catch(err => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      disposed = true
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  }, [handleRef])

  return (
    <>
      <div className="terminal" ref={hostRef} />
      {error && (
        <div className="terminal-error" role="alert">
          Terminal failed to start: {error}
        </div>
      )}
    </>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { createTerminal } from '../terminal.ts'
import type { TerminalHandle } from '../terminal.ts'

/**
 * Creates the terminal in `host` and wires it to the pty. Everything it sets up goes into `cleanups`, so a
 * session that is cut short (it stopped being wanted while the terminal was still loading) leaves nothing behind.
 */
async function startSession(
  host: HTMLElement,
  handleRef: RefObject<TerminalHandle | undefined>,
  isWanted: () => boolean,
  cleanups: (() => void)[],
) {
  const terminal = await createTerminal(host)
  if (!isWanted()) {
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
    window.app.pty.onData(data => {
      terminal.write(data)
    }),
    terminal.onData(data => {
      window.app.pty.write(data)
    }),
    terminal.onResize((cols, rows) => {
      window.app.pty.resize(cols, rows)
    }),
  )
  const { cols, rows } = terminal.fit()
  await window.app.pty.start(cols, rows)
  if (isWanted()) terminal.focus()
}

/**
 * Hosts the terminal. No key handlers are attached here or on the element: keys reach the
 * terminal untouched, and Cmd shortcuts are caught in main before they get here.
 */
export function TerminalPane({ handleRef }: Readonly<{ handleRef: RefObject<TerminalHandle | undefined> }>) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const life = new AbortController()
    const cleanups: (() => void)[] = []
    startSession(host, handleRef, () => !life.signal.aborted, cleanups).catch((err: unknown) => {
      if (!life.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      life.abort()
      for (const cleanup of cleanups.toReversed()) cleanup()
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

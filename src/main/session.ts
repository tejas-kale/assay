// Wires node-pty to the core's spawn spec and close flow. No window code here.
import nodePty from 'node-pty'

import { closeFlow } from '../core/session.ts'
import type { SpawnSpec } from '../core/session.ts'
import type { PtyExit } from '../shared/ipc.ts'

export type PtySession = {
  write(data: string): void
  resize(cols: number, rows: number): void
  flow: ReturnType<typeof closeFlow>
  /** Removes the pty listeners and timers. Does not kill the process. */
  dispose(): void
}

/** Throws when the pty cannot be spawned (bad shell path, native module missing). */
export function startSession(
  spec: SpawnSpec,
  cols: number,
  rows: number,
  handlers: { onData(data: string): void; onExit(exit: PtyExit): void },
): PtySession {
  const pty = nodePty.spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spec.cwd,
    env: spec.env,
  })
  let exited = false
  let exitCb: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const dataSub = pty.onData(handlers.onData)
  const exitSub = pty.onExit(event => {
    exited = true
    handlers.onExit({ exitCode: event.exitCode, ...(event.signal ? { signal: event.signal } : {}) })
    exitCb?.()
  })

  const flow = closeFlow({
    write: data => {
      if (!exited) pty.write(data)
    },
    kill: signal => {
      if (!exited) pty.kill(signal)
    },
    onExit: cb => {
      exitCb = cb
    },
    setTimer: (cb, ms) => {
      timer = setTimeout(cb, ms)
    },
  })

  return {
    flow,
    write: data => {
      if (!exited) pty.write(data)
    },
    resize: (c, r) => {
      if (exited) return
      try {
        pty.resize(c, r)
      } catch {
        // The pty went away between the check and the call.
      }
    },
    dispose: () => {
      clearTimeout(timer)
      dataSub.dispose()
      exitSub.dispose()
    },
  }
}

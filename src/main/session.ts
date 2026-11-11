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

type Handlers = { onData(data: string): void; onExit(exit: PtyExit): void }

/** What the pty's events leave behind for its close flow. */
type PtyState = { exited: boolean; exitCb: (() => void) | undefined; timer: ReturnType<typeof setTimeout> | undefined }

/** Throws when the pty cannot be spawned (bad shell path, native module missing). */
export function startSession(spec: SpawnSpec, cols: number, rows: number, handlers: Handlers): PtySession {
  const pty = nodePty.spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spec.cwd,
    env: spec.env,
  })
  const state: PtyState = { exited: false, exitCb: undefined, timer: undefined }
  const dataSub = pty.onData(data => {
    handlers.onData(data)
  })
  const exitSub = pty.onExit(event => {
    state.exited = true
    handlers.onExit({ exitCode: event.exitCode, ...(event.signal ? { signal: event.signal } : {}) })
    state.exitCb?.()
  })
  const write = (data: string) => {
    if (!state.exited) pty.write(data)
  }
  return {
    flow: flowFor(pty, state, write),
    write,
    resize: (c, r) => {
      if (!state.exited) resizeQuietly(pty, c, r)
    },
    dispose: () => {
      clearTimeout(state.timer)
      dataSub.dispose()
      exitSub.dispose()
    },
  }
}

function flowFor(pty: nodePty.IPty, state: PtyState, write: (data: string) => void) {
  return closeFlow({
    write,
    kill: signal => {
      if (!state.exited) pty.kill(signal)
    },
    onExit: cb => {
      state.exitCb = cb
    },
    setTimer: (cb, ms) => {
      state.timer = setTimeout(cb, ms)
    },
  })
}

/** The pty may have gone away between the caller's check and the call. */
function resizeQuietly(pty: nodePty.IPty, cols: number, rows: number) {
  try {
    pty.resize(cols, rows)
  } catch {
    // Nothing to resize any more.
  }
}

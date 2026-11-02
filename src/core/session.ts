export type SpawnSpec = { file: string; args: string[]; cwd: string; env: Record<string, string> }

/** Where the wrapper mounts this repository's plugin in the container (config repo, bin/claude). */
export const PLUGIN_DIR = '/opt/assay/plugin'

/**
 * How to start the wrapper. A GUI app has a thin PATH, so it runs through the user's login,
 * interactive shell, which finds `claude` as a terminal would. Claude loads Assay's plugin; the
 * server finds the analysis in ASSAY_ANALYSIS and the shared folder (Settings) in ASSAY_ROOT. Claude starts in the
 * root, so it can read what is shared; the prompt hook names the open analysis.
 */
export function spawnSpec(folder: string, env: Record<string, string | undefined>, root: string): SpawnSpec {
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') clean[name] = value
  }
  return {
    file: env.SHELL || '/bin/zsh',
    args: ['-lic', `exec "\${ASSAY_CLAUDE_BIN:-claude}" --plugin-dir ${PLUGIN_DIR}`],
    cwd: root,
    env: { ...clean, ASSAY_APP: '1', ASSAY_ROOT: root, ASSAY_ANALYSIS: folder, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  }
}

export type CloseState = 'running' | 'closing' | 'exited'

export type CloseFlowPort = {
  write(data: string): void
  kill(signal: 'SIGHUP'): void
  onExit(cb: () => void): void
  setTimer(cb: () => void, ms: number): void
}

const CTRL_C = '\x03'
// Claude Code exits on two Ctrl-C presses close together.
const SECOND_PRESS_MS = 300

/**
 * The graceful close. The wrapper must finish its git import after Claude exits, so after the
 * two presses nothing more is written (a third Ctrl-C could interrupt the import) and only an
 * explicit `forceKill` sends a signal.
 */
export function closeFlow(port: CloseFlowPort) {
  let state: CloseState = 'running'
  const listeners: ((state: CloseState) => void)[] = []
  const set = (next: CloseState) => {
    state = next
    for (const listener of listeners) listener(next)
  }
  port.onExit(() => {
    if (state !== 'exited') set('exited')
  })
  return {
    state: () => state,
    onChange(cb: (state: CloseState) => void) {
      listeners.push(cb)
    },
    /** Begins the close; calling it again while closing does nothing. */
    start() {
      if (state !== 'running') return
      set('closing')
      port.write(CTRL_C)
      port.setTimer(() => {
        if (state === 'closing') port.write(CTRL_C)
      }, SECOND_PRESS_MS)
    },
    forceKill() {
      if (state !== 'exited') port.kill('SIGHUP')
    },
  }
}

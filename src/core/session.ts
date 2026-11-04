import type { ThemeMode } from './theme.ts'

export type SpawnSpec = { file: string; args: string[]; cwd: string; env: Record<string, string> }

/** Where the wrapper mounts this repository's plugin in the container (config repo, bin/claude). */
export const PLUGIN_DIR = '/opt/assay/plugin'

/**
 * Claude Code's theme for a session. The ANSI themes draw with the terminal's 16 colours, which are
 * Ayu's here, so Claude matches the app; and a live light/dark switch recolours them like any other
 * cell. The wrapper passes it to Claude through `--settings`, over the theme saved in its own home.
 */
export const claudeTheme = (mode: ThemeMode) => (mode === 'dark' ? 'dark-ansi' : 'light-ansi')

/**
 * How to start the wrapper. A GUI app has a thin PATH, so it runs through the user's login,
 * interactive shell, which finds `claude` as a terminal would. Claude loads Assay's plugin; the
 * server finds the analysis in ASSAY_ANALYSIS and the shared folder (Settings) in ASSAY_ROOT. Claude starts in the
 * root, so it can read what is shared; the prompt hook names the open analysis.
 */
export function spawnSpec(folder: string, env: Record<string, string | undefined>, root: string, mode: ThemeMode): SpawnSpec {
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') clean[name] = value
  }
  return {
    file: env.SHELL || '/bin/zsh',
    args: ['-lic', `exec "\${ASSAY_CLAUDE_BIN:-claude}" --plugin-dir ${PLUGIN_DIR}`],
    cwd: root,
    env: { ...clean, ASSAY_APP: '1', ASSAY_ROOT: root, ASSAY_ANALYSIS: folder, ASSAY_THEME: claudeTheme(mode), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  }
}

export type CloseState = 'running' | 'closing' | 'exited'

export type CloseFlowPort = {
  write(data: string): void
  kill(signal: 'SIGHUP' | 'SIGKILL'): void
  onExit(cb: () => void): void
  setTimer(cb: () => void, ms: number): void
}

const ESC = '\x1b'
const CTRL_C = '\x03'
// Esc first leaves a sub-view (the agents view, a menu), where Ctrl-C does not exit. The pause keeps
// the Esc from being read as Alt with the Ctrl-C that follows.
const FIRST_PRESS_MS = 150
// Claude Code exits on two Ctrl-C presses close together.
const SECOND_PRESS_MS = FIRST_PRESS_MS + 300
/** A session that ignores SIGHUP gets SIGKILL this long after it. */
export const KILL_AFTER_MS = 2000

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
      port.write(ESC)
      port.setTimer(() => {
        if (state === 'closing') port.write(CTRL_C)
      }, FIRST_PRESS_MS)
      port.setTimer(() => {
        if (state === 'closing') port.write(CTRL_C)
      }, SECOND_PRESS_MS)
    },
    /** SIGHUP, then SIGKILL if the session is still there after KILL_AFTER_MS. */
    forceKill() {
      if (state === 'exited') return
      port.kill('SIGHUP')
      port.setTimer(() => {
        if (state !== 'exited') port.kill('SIGKILL')
      }, KILL_AFTER_MS)
    },
  }
}

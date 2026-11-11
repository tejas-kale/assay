import type { ThemeMode } from './theme.ts'

export type SpawnSpec = { file: string; args: string[]; cwd: string; env: Record<string, string> }

/**
 * Claude Code's theme for a session. The ANSI themes draw with the terminal's 16 colours, which are
 * Ayu's here, so Claude matches the app; and a live light/dark switch recolours them like any other
 * cell. A launcher passes it to Claude through `--settings`, over the theme saved in its own home.
 */
export const claudeTheme = (mode: ThemeMode) => (mode === 'dark' ? 'dark-ansi' : 'light-ansi')

export type Launch = {
  /** The open analysis's folder. */
  folder: string
  /** The app's environment, passed on to Claude. */
  env: Record<string, string | undefined>
  /** The Settings folder: Claude starts there. */
  root: string
  mode: ThemeMode
  /** This version's installed backend (plugin, server, hooks, Python project). */
  backend: string
  /** This version's venv, which runs every tool. */
  venv: string
}

/**
 * How to start Claude (docs/process/launch-contract.md). A GUI app has a thin PATH, so it runs through the user's
 * login, interactive shell, which finds `claude` as a terminal would. Claude loads the backend's plugin; the server
 * finds the analysis in ASSAY_ANALYSIS and the shared folder (Settings) in ASSAY_ROOT. Claude starts in the root, so
 * it can read what is shared; the prompt hook names the open analysis.
 */
export function spawnSpec({ folder, env, root, mode, backend, venv }: Launch): SpawnSpec {
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') clean[name] = value
  }
  return {
    file: env.SHELL || '/bin/zsh',
    // Both paths are expanded by the shell from the environment, so the space in Application Support stays one word.
    // No --strict-mcp-config: a launcher adds its own servers.
    args: ['-lic', 'exec "${ASSAY_CLAUDE_BIN:-claude}" --mcp-config "$ASSAY_MCP_CONFIG" --plugin-dir "$ASSAY_BACKEND/plugin"'],
    cwd: root,
    env: {
      ...clean,
      ASSAY_APP: '1',
      ASSAY_ROOT: root,
      ASSAY_ANALYSIS: folder,
      ASSAY_BACKEND: backend,
      ASSAY_VENV: venv,
      ASSAY_MCP_CONFIG: mcpConfig(backend),
      ASSAY_THEME: claudeTheme(mode),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  }
}

/**
 * The server `assay`, declared by the app rather than the plugin: Claude Code names a plugin's server
 * `plugin:<plugin>:<server>`, so its tools would be `mcp__assay__*`. A launcher allowlists the server by
 * its exact command: `node` and one argument, with `plugin/..` kept as written.
 */
export const mcpConfig = (backend: string) =>
  JSON.stringify({ mcpServers: { assay: { command: 'node', args: [`${backend}/plugin/../out/server/index.mjs`] } } })

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

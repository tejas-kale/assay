import assert from 'node:assert/strict'
import { test } from 'node:test'

import { closeFlow, spawnSpec } from './session.ts'
import type { CloseState } from './session.ts'

const BACKEND = '/Users/me/Library/Application Support/Assay/backend/0.4.3'
const VENV = '/Users/me/Library/Application Support/Assay/venvs/0.4.3'
const launch = (folder: string, env: Record<string, string | undefined>, root: string, mode: 'dark' | 'light' = 'dark') =>
  spawnSpec({ folder, env, root, mode, backend: BACKEND, venv: VENV })

test('spawnSpec runs Claude through the login shell from SHELL, with the shipped plugin', () => {
  const spec = launch('/notes/analyses/a', { SHELL: '/opt/homebrew/bin/fish', PATH: '/usr/bin' }, '/notes')
  assert.equal(spec.file, '/opt/homebrew/bin/fish')
  // The plugin path is read from the environment, so its space never meets the shell's word splitting.
  assert.deepEqual(spec.args, ['-lic', 'exec "${ASSAY_CLAUDE_BIN:-claude}" --plugin-dir "$ASSAY_BACKEND/plugin"'])
  // Claude starts in the root; the open analysis is named in ASSAY_ANALYSIS.
  assert.equal(spec.cwd, '/notes')
  assert.equal(spec.env.ASSAY_ANALYSIS, '/notes/analyses/a')
  assert.equal(spec.env.ASSAY_ROOT, '/notes')
})

test('spawnSpec passes the backend and venv paths, spaces and all', () => {
  const spec = launch('/f', {}, '/')
  assert.equal(spec.env.ASSAY_BACKEND, BACKEND)
  assert.equal(spec.env.ASSAY_VENV, VENV)
})

test('spawnSpec sets its own backend and venv over any inherited', () => {
  const spec = launch('/f', { ASSAY_VENV: '/opt/venv-assay', ASSAY_BACKEND: '/opt/assay' }, '/')
  assert.equal(spec.env.ASSAY_VENV, VENV)
  assert.equal(spec.env.ASSAY_BACKEND, BACKEND)
})

test('spawnSpec falls back to zsh and sets the terminal and app variables', () => {
  const spec = launch('/f', { PATH: '/usr/bin', HOME: '/Users/me' }, '/')
  assert.equal(spec.file, '/bin/zsh')
  assert.equal(spec.env.ASSAY_APP, '1')
  assert.equal(spec.env.TERM, 'xterm-256color')
  assert.equal(spec.env.COLORTERM, 'truecolor')
  assert.equal(spec.env.HOME, '/Users/me')
})

test("spawnSpec asks for Claude Code's ANSI theme in the system's mode", () => {
  assert.equal(launch('/f', {}, '/', 'dark').env.ASSAY_THEME, 'dark-ansi')
  assert.equal(launch('/f', {}, '/', 'light').env.ASSAY_THEME, 'light-ansi')
})

test('spawnSpec removes ELECTRON_RUN_AS_NODE, overrides TERM, drops undefined values, leaves the input alone', () => {
  const env = { ELECTRON_RUN_AS_NODE: '1', TERM: 'dumb', GONE: undefined, KEEP: 'x' }
  const spec = launch('/f', env, '/')
  assert.equal('ELECTRON_RUN_AS_NODE' in spec.env, false)
  assert.equal('GONE' in spec.env, false)
  assert.equal(spec.env.TERM, 'xterm-256color')
  assert.equal(spec.env.KEEP, 'x')
  assert.equal(env.TERM, 'dumb')
})

function fakeFlow() {
  const writes: string[] = []
  const kills: string[] = []
  const timers: { cb: () => void; ms: number }[] = []
  let exit: () => void = () => {}
  const states: CloseState[] = []
  const flow = closeFlow({
    write: data => void writes.push(data),
    kill: signal => void kills.push(signal),
    onExit: cb => {
      exit = cb
    },
    setTimer: (cb, ms) => void timers.push({ cb, ms }),
  })
  flow.onChange(state => states.push(state))
  return { flow, writes, kills, timers, states, exit: () => exit() }
}

test('closeFlow starts running; start writes Esc, then Ctrl-C twice, 300 ms apart, then nothing', () => {
  const t = fakeFlow()
  assert.equal(t.flow.state(), 'running')
  t.flow.start()
  assert.equal(t.flow.state(), 'closing')
  assert.deepEqual(t.writes, ['\x1b'])
  assert.deepEqual(t.timers.map(x => x.ms), [150, 450])
  t.timers[0]?.cb()
  t.timers[1]?.cb()
  assert.deepEqual(t.writes, ['\x1b', '\x03', '\x03'])
  assert.equal(t.timers.length, 2)
  assert.deepEqual(t.kills, [])
})

test('a second start while closing writes nothing more', () => {
  const t = fakeFlow()
  t.flow.start()
  for (const timer of t.timers) timer.cb()
  t.flow.start()
  t.flow.start()
  assert.deepEqual(t.writes, ['\x1b', '\x03', '\x03'])
  assert.equal(t.timers.length, 2)
})

test('exit from running or closing moves to exited, and a pending second Ctrl-C is not written', () => {
  const a = fakeFlow()
  a.exit()
  assert.equal(a.flow.state(), 'exited')

  const b = fakeFlow()
  b.flow.start()
  b.exit()
  for (const timer of b.timers) timer.cb()
  assert.equal(b.flow.state(), 'exited')
  assert.deepEqual(b.writes, ['\x1b'])
  b.flow.start()
  assert.deepEqual(b.writes, ['\x1b'])
  assert.deepEqual(b.states, ['closing', 'exited'])
})

test('forceKill sends SIGHUP while the session lives, and never after exit', () => {
  const t = fakeFlow()
  t.flow.start()
  t.flow.forceKill()
  assert.deepEqual(t.kills, ['SIGHUP'])
  t.exit()
  for (const timer of t.timers) timer.cb()
  t.flow.forceKill()
  assert.deepEqual(t.kills, ['SIGHUP'])
})

test('forceKill follows with SIGKILL when SIGHUP did not end the session', () => {
  const t = fakeFlow()
  t.flow.start()
  t.flow.forceKill()
  assert.equal(t.timers.at(-1)?.ms, 2000)
  t.timers.at(-1)?.cb()
  assert.deepEqual(t.kills, ['SIGHUP', 'SIGKILL'])
})

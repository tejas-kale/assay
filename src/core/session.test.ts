import assert from 'node:assert/strict'
import { test } from 'node:test'

import { closeFlow, spawnSpec } from './session.ts'
import type { CloseState } from './session.ts'

test('spawnSpec runs the wrapper through the login shell from SHELL', () => {
  const spec = spawnSpec('/notes/analyses/a', { SHELL: '/opt/homebrew/bin/fish', PATH: '/usr/bin' })
  assert.equal(spec.file, '/opt/homebrew/bin/fish')
  assert.deepEqual(spec.args, ['-lic', 'exec "${ANALYSIS_CLAUDE_BIN:-claude}"'])
  assert.equal(spec.cwd, '/notes/analyses/a')
})

test('spawnSpec falls back to zsh and sets the terminal and app variables', () => {
  const spec = spawnSpec('/f', { PATH: '/usr/bin', HOME: '/Users/me' })
  assert.equal(spec.file, '/bin/zsh')
  assert.equal(spec.env.ANALYSIS_APP, '1')
  assert.equal(spec.env.TERM, 'xterm-256color')
  assert.equal(spec.env.COLORTERM, 'truecolor')
  assert.equal(spec.env.HOME, '/Users/me')
})

test('spawnSpec removes ELECTRON_RUN_AS_NODE, overrides TERM, drops undefined values, leaves the input alone', () => {
  const env = { ELECTRON_RUN_AS_NODE: '1', TERM: 'dumb', GONE: undefined, KEEP: 'x' }
  const spec = spawnSpec('/f', env)
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

test('closeFlow starts running; start writes Ctrl-C, then once more after 300 ms, then nothing', () => {
  const t = fakeFlow()
  assert.equal(t.flow.state(), 'running')
  t.flow.start()
  assert.equal(t.flow.state(), 'closing')
  assert.deepEqual(t.writes, ['\x03'])
  assert.deepEqual(t.timers.map(x => x.ms), [300])
  t.timers[0]?.cb()
  assert.deepEqual(t.writes, ['\x03', '\x03'])
  assert.equal(t.timers.length, 1)
  assert.deepEqual(t.kills, [])
})

test('a second start while closing writes nothing more', () => {
  const t = fakeFlow()
  t.flow.start()
  t.timers[0]?.cb()
  t.flow.start()
  t.flow.start()
  assert.deepEqual(t.writes, ['\x03', '\x03'])
  assert.equal(t.timers.length, 1)
})

test('exit from running or closing moves to exited, and a pending second Ctrl-C is not written', () => {
  const a = fakeFlow()
  a.exit()
  assert.equal(a.flow.state(), 'exited')

  const b = fakeFlow()
  b.flow.start()
  b.exit()
  b.timers[0]?.cb()
  assert.equal(b.flow.state(), 'exited')
  assert.deepEqual(b.writes, ['\x03'])
  b.flow.start()
  assert.deepEqual(b.writes, ['\x03'])
  assert.deepEqual(b.states, ['closing', 'exited'])
})

test('forceKill sends SIGHUP while the session lives, and never after exit', () => {
  const t = fakeFlow()
  t.flow.start()
  t.flow.forceKill()
  assert.deepEqual(t.kills, ['SIGHUP'])
  t.exit()
  t.flow.forceKill()
  assert.deepEqual(t.kills, ['SIGHUP'])
})

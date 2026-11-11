import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HOLD_MS, cmdHold } from './cmdHold.ts'
import type { HoldKind } from './cmdHold.ts'

function setup() {
  const seen: (HoldKind | undefined)[] = []
  const timers: { cb: () => void; ms: number; cancelled: boolean }[] = []
  const hold = cmdHold({
    onChange: visible => seen.push(visible),
    setTimer(cb, ms) {
      const timer = { cb, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  const fire = () => {
    for (const timer of timers.filter(t => !t.cancelled)) timer.cb()
  }
  return { hold, seen, timers, fire }
}

test('holding left Cmd shows the hints after the hold time, and releasing hides them', () => {
  const { hold, seen, timers, fire } = setup()
  hold.key('keyDown', 'MetaLeft')
  assert.deepEqual(seen, [])
  assert.equal(timers[0]?.ms, HOLD_MS)
  fire()
  assert.deepEqual(seen, ['cmd'])
  hold.key('keyUp', 'MetaLeft')
  assert.deepEqual(seen, ['cmd', undefined])
})

test('a quick tap shows nothing', () => {
  const { hold, seen, timers } = setup()
  hold.key('keyDown', 'MetaLeft')
  hold.key('keyUp', 'MetaLeft')
  assert.equal(timers[0]?.cancelled, true)
  assert.deepEqual(seen, [])
})

test('the right Cmd key does nothing', () => {
  const { hold, seen, timers } = setup()
  hold.key('keyDown', 'MetaRight')
  hold.key('keyUp', 'MetaRight')
  assert.equal(timers.length, 0)
  assert.deepEqual(seen, [])
})

test('a shortcut pressed before the hold time cancels the hints', () => {
  const { hold, seen, timers } = setup()
  hold.key('keyDown', 'MetaLeft')
  hold.key('keyDown', 'Digit1')
  assert.equal(timers[0]?.cancelled, true)
  assert.deepEqual(seen, [])
})

test('a shortcut pressed while they show hides them, and they stay hidden until the next press', () => {
  const { hold, seen, timers, fire } = setup()
  hold.key('keyDown', 'MetaLeft')
  fire()
  hold.key('keyDown', 'KeyP')
  assert.deepEqual(seen, ['cmd', undefined])
  hold.key('keyUp', 'MetaLeft')
  assert.deepEqual(seen, ['cmd', undefined])
  hold.key('keyDown', 'MetaLeft')
  assert.equal(timers.length, 2)
})

test('Shift on its own does not cancel, so Cmd+Shift hints stay reachable', () => {
  const { hold, seen, fire } = setup()
  hold.key('keyDown', 'MetaLeft')
  hold.key('keyDown', 'ShiftLeft')
  fire()
  assert.deepEqual(seen, ['cmd'])
  hold.key('keyUp', 'ShiftLeft')
  assert.deepEqual(seen, ['cmd'])
})

test('losing window focus hides them, since the key-up would never arrive', () => {
  const { hold, seen, timers, fire } = setup()
  hold.key('keyDown', 'MetaLeft')
  fire()
  hold.blur()
  assert.deepEqual(seen, ['cmd', undefined])
  hold.key('keyDown', 'MetaLeft')
  hold.blur()
  assert.equal(timers[1]?.cancelled, true)
  assert.deepEqual(seen, ['cmd', undefined])
})

test('a repeated key-down does not start a second timer', () => {
  const { hold, timers } = setup()
  hold.key('keyDown', 'MetaLeft')
  hold.key('keyDown', 'MetaLeft')
  assert.equal(timers.length, 1)
})

test('holding left Ctrl shows the pane hints; releasing hides them', () => {
  const { hold, seen, timers, fire } = setup()
  hold.key('keyDown', 'ControlLeft')
  assert.equal(timers[0]?.ms, HOLD_MS)
  fire()
  hold.key('keyUp', 'ControlLeft')
  assert.deepEqual(seen, ['ctrl', undefined])
})

test('a Ctrl key combination such as Ctrl-C cancels the Ctrl hold, so typing in the terminal never flashes hints', () => {
  const { hold, seen, timers } = setup()
  hold.key('keyDown', 'ControlLeft')
  hold.key('keyDown', 'KeyC')
  assert.equal(timers[0]?.cancelled, true)
  assert.deepEqual(seen, [])
})

test('pressing the other hold key while one is held cancels both', () => {
  const { hold, seen, timers, fire } = setup()
  hold.key('keyDown', 'MetaLeft')
  hold.key('keyDown', 'ControlLeft')
  fire()
  assert.equal(timers[0]?.cancelled, true)
  assert.deepEqual(seen, [])
})

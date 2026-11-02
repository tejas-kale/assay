import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HOLD_MS, cmdHold } from './cmdHold.ts'

function setup() {
  const seen: boolean[] = []
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
  const fire = () => timers.filter(t => !t.cancelled).forEach(t => t.cb())
  return { hold, seen, timers, fire }
}

test('holding left Cmd shows the hints after the hold time, and releasing hides them', () => {
  const { hold, seen, timers, fire } = setup()
  hold.key('keyDown', 'MetaLeft')
  assert.deepEqual(seen, [])
  assert.equal(timers[0]?.ms, HOLD_MS)
  fire()
  assert.deepEqual(seen, [true])
  hold.key('keyUp', 'MetaLeft')
  assert.deepEqual(seen, [true, false])
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
  assert.deepEqual(seen, [true, false])
  hold.key('keyUp', 'MetaLeft')
  assert.deepEqual(seen, [true, false])
  hold.key('keyDown', 'MetaLeft')
  assert.equal(timers.length, 2)
})

test('Shift on its own does not cancel, so Cmd+Shift hints stay reachable', () => {
  const { hold, seen, fire } = setup()
  hold.key('keyDown', 'MetaLeft')
  hold.key('keyDown', 'ShiftLeft')
  fire()
  assert.deepEqual(seen, [true])
  hold.key('keyUp', 'ShiftLeft')
  assert.deepEqual(seen, [true])
})

test('losing window focus hides them, since the key-up would never arrive', () => {
  const { hold, seen, timers, fire } = setup()
  hold.key('keyDown', 'MetaLeft')
  fire()
  hold.blur()
  assert.deepEqual(seen, [true, false])
  hold.key('keyDown', 'MetaLeft')
  hold.blur()
  assert.equal(timers[1]?.cancelled, true)
  assert.deepEqual(seen, [true, false])
})

test('a repeated key-down does not start a second timer', () => {
  const { hold, timers } = setup()
  hold.key('keyDown', 'MetaLeft')
  hold.key('keyDown', 'MetaLeft')
  assert.equal(timers.length, 1)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chosenRuns, confirmText, initReplay, replayKey } from './replay.ts'
import type { ReplayState } from './replay.ts'

const runs = [
  { number: 14, label: '014', slug: 'b', status: 'ok' },
  { number: 12, label: '012', slug: 'a', status: 'ok' },
  { number: 15, label: '015', slug: 'c', status: 'error' },
  { number: 16, label: '016', slug: 'd', status: 'ok', replay: 12 },
] as const

const press = (state: ReplayState, ...keys: string[]) => keys.reduce((s, key) => replayKey(s, key).state, state)

test('the list is oldest first, with the ok runs that are not replays chosen', () => {
  const state = initReplay(runs)
  assert.deepEqual(state.runs.map(r => r.number), [12, 14, 15, 16])
  assert.deepEqual(chosenRuns(state), [12, 14])
  assert.equal(state.cursor, 0)
  assert.equal(state.mode, 'pick')
})

test('j and k move the cursor and stop at the ends', () => {
  const state = initReplay(runs)
  assert.equal(press(state, 'k').cursor, 0)
  assert.equal(press(state, 'j', 'j').cursor, 2)
  assert.equal(press(state, 'j', 'j', 'j', 'j', 'j').cursor, 3)
  assert.equal(press(state, 'ArrowDown', 'ArrowDown', 'ArrowUp').cursor, 1)
})

test('space toggles the run under the cursor; the result stays in run order', () => {
  const state = press(initReplay(runs), 'j', 'j', ' ', 'k', 'k', ' ')
  assert.deepEqual(chosenRuns(state), [14, 15])
  assert.deepEqual(chosenRuns(press(state, 'j', 'j', ' ')), [14])
})

test('a chooses all, and chooses none when all are chosen', () => {
  const all = press(initReplay(runs), 'a')
  assert.deepEqual(chosenRuns(all), [12, 14, 15, 16])
  assert.deepEqual(chosenRuns(press(all, 'a')), [])
})

test('Enter asks to confirm only when something is chosen; y sends in run order', () => {
  assert.equal(replayKey(press(initReplay(runs), 'a', 'a'), 'Enter').state.mode, 'pick')
  const ask = press(initReplay(runs), 'Enter')
  assert.equal(ask.mode, 'confirm')
  assert.equal(confirmText(ask), 'Replay 2 runs in a new kernel? y / n')
  assert.equal(confirmText(press(initReplay(runs), ' ', 'Enter')), 'Replay 1 run in a new kernel? y / n')
  assert.deepEqual(replayKey(ask, 'y'), { state: ask, effect: { type: 'send', runs: [12, 14] } })
})

test('n and Escape go back from the confirm; Escape in the list leaves', () => {
  const ask = press(initReplay(runs), 'Enter')
  assert.equal(replayKey(ask, 'n').state.mode, 'pick')
  assert.equal(replayKey(ask, 'Escape').state.mode, 'pick')
  assert.equal(replayKey(ask, 'Escape').effect, undefined)
  assert.deepEqual(replayKey(initReplay(runs), 'Escape').effect, { type: 'leave' })
})

test('other keys do nothing while confirming, and nothing sends from the list', () => {
  const ask = press(initReplay(runs), 'Enter')
  assert.deepEqual(replayKey(ask, 'j'), { state: ask })
  assert.equal(replayKey(initReplay(runs), 'y').effect, undefined)
})

test('an empty list stays empty and asks for nothing', () => {
  const state = initReplay([])
  assert.equal(replayKey(state, 'Enter').state.mode, 'pick')
  assert.equal(replayKey(state, 'j').state.cursor, 0)
})

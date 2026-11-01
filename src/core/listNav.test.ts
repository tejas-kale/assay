import assert from 'node:assert/strict'
import { test } from 'node:test'

import { INITIAL, filterItems, listNav } from './listNav.ts'
import type { ListNavState } from './listNav.ts'

const press = (state: ListNavState, keys: string[], count = 5) => {
  let current = state
  let effect: { type: 'open' } | undefined
  for (const key of keys) ({ state: current, effect } = listNav(current, key, count))
  return { state: current, effect }
}

test('j and k move, clamped to the list', () => {
  assert.equal(press(INITIAL, ['j', 'j']).state.selected, 2)
  assert.equal(press(INITIAL, ['k']).state.selected, 0)
  assert.equal(press(INITIAL, ['j', 'j', 'j', 'j', 'j', 'j', 'j']).state.selected, 4)
  assert.equal(press(INITIAL, ['ArrowDown', 'ArrowDown', 'ArrowUp']).state.selected, 1)
})

test('g goes to the top and G to the bottom', () => {
  assert.equal(press({ ...INITIAL, selected: 3 }, ['g']).state.selected, 0)
  assert.equal(press(INITIAL, ['G']).state.selected, 4)
})

test('an empty list keeps selected at 0 and Enter opens nothing', () => {
  const { state, effect } = press(INITIAL, ['j', 'G', 'Enter'], 0)
  assert.equal(state.selected, 0)
  assert.equal(effect, undefined)
})

test('Enter asks to open the selected item', () => {
  const { state, effect } = press(INITIAL, ['j', 'Enter'])
  assert.deepEqual(effect, { type: 'open' })
  assert.equal(state.selected, 1)
})

test('a selection beyond a shrunken list is pulled back', () => {
  assert.equal(listNav({ ...INITIAL, selected: 9 }, 'k', 3).state.selected, 1)
})

test('/ starts a search; keys then type into the query instead of moving', () => {
  const { state } = press({ ...INITIAL, selected: 3 }, ['/', 'j', 'k', 'g'])
  assert.deepEqual(state, { selected: 0, search: { active: true, query: 'jkg' } })
})

test('Backspace edits the query; typing resets the selection to the top', () => {
  const { state } = press(INITIAL, ['/', 'a', 'b', 'Backspace'])
  assert.deepEqual(state.search, { active: true, query: 'a' })
  assert.equal(press({ ...INITIAL, selected: 3 }, ['/', 'a']).state.selected, 0)
})

test('Enter in a search keeps the filter and returns to moving, without opening', () => {
  const { state, effect } = press(INITIAL, ['/', 'a', 'Enter'])
  assert.deepEqual(state.search, { active: false, query: 'a' })
  assert.equal(effect, undefined)
  assert.equal(press(state, ['j'], 3).state.selected, 1)
  assert.deepEqual(press(state, ['Enter']).effect, { type: 'open' })
})

test('Escape clears the search, active or not; without one it changes nothing', () => {
  assert.equal(press(INITIAL, ['/', 'a', 'Escape']).state.search, undefined)
  assert.equal(press(INITIAL, ['/', 'a', 'Enter', 'Escape']).state.search, undefined)
  const same = press({ ...INITIAL, selected: 2 }, ['Escape']).state
  assert.deepEqual(same, { selected: 2, search: undefined })
})

test('unknown keys and modified keys do nothing', () => {
  assert.deepEqual(press(INITIAL, ['x', 'Tab', 'Shift']).state, INITIAL)
})

test('filterItems ranks with fuzzyRank while a search has text, else returns the list', () => {
  const items = ['alpha', 'beta', 'alpine']
  const id = (s: string) => s
  assert.deepEqual(filterItems(items, INITIAL, id), items)
  assert.deepEqual(filterItems(items, { selected: 0, search: { active: true, query: 'alp' } }, id), ['alpha', 'alpine'])
  assert.deepEqual(filterItems(items, { selected: 0, search: { active: false, query: '' } }, id), items)
})

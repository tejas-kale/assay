import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pickerKey, pickerSubmit, pickerView } from './picker.ts'

const list = [
  { path: '/a/one', title: 'Churn study', name: 'churn-study' },
  { path: '/a/two', title: 'Pricing', name: 'pricing' },
]

test('while the list loads nothing can be created', () => {
  const view = pickerView(undefined, 'new thing')
  assert.equal(view.canCreate, false)
  assert.equal(view.canForceCreate, false)
  assert.equal(view.count, 0)
})

test('a query with no match and a valid title offers one create row', () => {
  const view = pickerView(list, 'zzz qqq')
  assert.equal(view.canCreate, true)
  assert.equal(view.title, 'zzz qqq')
  assert.equal(view.count, 1)
  assert.deepEqual(pickerSubmit(view, 0, 'zzz qqq'), { do: 'create' })
})

test('matches are listed, and Shift+Enter may still create unless the title exists', () => {
  const view = pickerView(list, 'pri')
  assert.deepEqual(view.ranked.map(a => a.name), ['pricing'])
  assert.equal(view.canCreate, false)
  assert.equal(view.canForceCreate, true)
  assert.deepEqual(pickerSubmit(view, 0, 'pri'), { do: 'open', path: '/a/two' })
  assert.equal(pickerView(list, '  Pricing ').canForceCreate, false)
})

test('a query that is no title says so only when something was typed', () => {
  const view = pickerView(list, '!!!')
  assert.equal(view.title, '')
  assert.equal(view.count, 0)
  assert.deepEqual(pickerSubmit(view, 0, '!!!'), { do: 'warn', message: 'No match. Type a title with letters or digits.' })
  assert.deepEqual(pickerSubmit(pickerView([], '   '), 0, '   '), { do: 'nothing' })
  assert.deepEqual(pickerSubmit(pickerView(list, ''), 1, ''), { do: 'open', path: '/a/two' })
})

test('keys: arrows and Ctrl-n/p move, Enter submits, Shift+Enter forces a create, Escape clears', () => {
  const plain = { ctrl: false, shift: false, composing: false }
  assert.equal(pickerKey('ArrowDown', plain), 'next')
  assert.equal(pickerKey('n', { ...plain, ctrl: true }), 'next')
  assert.equal(pickerKey('ArrowUp', plain), 'previous')
  assert.equal(pickerKey('p', { ...plain, ctrl: true }), 'previous')
  assert.equal(pickerKey('Enter', plain), 'submit')
  assert.equal(pickerKey('Enter', { ...plain, shift: true }), 'forceCreate')
  assert.equal(pickerKey('Escape', plain), 'clear')
  assert.equal(pickerKey('x', plain), undefined)
  assert.equal(pickerKey('Enter', { ...plain, composing: true }), undefined)
})

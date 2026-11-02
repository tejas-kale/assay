import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMMANDS, commandForInput, shortcutLabel } from './keymap.ts'

const input = (over: Partial<Parameters<typeof commandForInput>[0]>) => ({
  key: '',
  code: '',
  meta: false,
  shift: false,
  ctrl: false,
  alt: false,
  ...over,
})

test('every handoff shortcut maps to its command, by code', () => {
  const table: [Partial<Parameters<typeof commandForInput>[0]>, string][] = [
    [{ code: 'Digit1', meta: true }, 'focus.terminal'],
    [{ code: 'Digit2', meta: true }, 'focus.notes'],
    [{ code: 'Digit3', meta: true }, 'focus.data'],
    [{ code: 'KeyP', meta: true }, 'palette.open'],
    [{ code: 'Comma', meta: true }, 'settings.open'],
    [{ code: 'Enter', meta: true }, 'code.run'],
    [{ code: 'KeyN', meta: true }, 'window.new'],
    [{ code: 'KeyW', meta: true }, 'window.close'],
    [{ code: 'KeyD', meta: true, shift: true }, 'tab.data'],
    [{ code: 'KeyP', meta: true, shift: true }, 'tab.plots'],
    [{ code: 'KeyC', meta: true, shift: true }, 'tab.code'],
    [{ code: 'KeyH', meta: true, shift: true }, 'tab.history'],
  ]
  for (const [over, id] of table) assert.equal(commandForInput(input(over)), id, id)
})

test('the layout does not matter: code decides, key is ignored', () => {
  assert.equal(commandForInput(input({ code: 'Digit1', key: '&', meta: true })), 'focus.terminal')
  assert.equal(commandForInput(input({ code: 'KeyP', key: 'з', meta: true })), 'palette.open')
})

test('copy, paste, select-all, quit and every non-Cmd key are not claimed', () => {
  for (const code of ['KeyC', 'KeyV', 'KeyA', 'KeyQ', 'KeyX', 'KeyZ', 'KeyK']) {
    assert.equal(commandForInput(input({ code, meta: true })), undefined, code)
  }
  for (const code of ['Digit1', 'KeyP', 'KeyN', 'KeyW', 'Enter', 'KeyD']) {
    assert.equal(commandForInput(input({ code })), undefined, code)
    assert.equal(commandForInput(input({ code, ctrl: true })), undefined, `ctrl ${code}`)
    assert.equal(commandForInput(input({ code, shift: true })), undefined, `shift ${code}`)
  }
})

test('extra modifiers do not match: Cmd+Shift+1, Cmd+Alt+P, Cmd+Ctrl+N, Cmd+Shift+N', () => {
  assert.equal(commandForInput(input({ code: 'Digit1', meta: true, shift: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyP', meta: true, alt: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyN', meta: true, ctrl: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyN', meta: true, shift: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyD', meta: true })), undefined)
})

test('COMMANDS lists every action once, with titles', () => {
  const ids = COMMANDS.map(c => c.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of [
    'focus.terminal', 'focus.notes', 'focus.data', 'palette.open', 'code.run', 'window.new',
    'tab.data', 'tab.plots', 'tab.code', 'tab.history', 'tab.notes', 'tab.threads',
    'window.close', 'settings.open', 'pin.toggle', 'kernel.restart', 'replay.open',
  ]) assert.ok(ids.includes(id as never), id)
  for (const c of COMMANDS) assert.ok(c.title.length > 0)
})

test('no two commands share an accelerator', () => {
  const keys = COMMANDS.flatMap(c => (c.accelerator ? [JSON.stringify(c.accelerator)] : []))
  assert.equal(new Set(keys).size, keys.length)
})

test('pin, restart and replay are palette-only and say which slice brings them', () => {
  const later = COMMANDS.filter(c => c.unavailable !== undefined)
  assert.deepEqual(later.map(c => c.id), ['pin.toggle', 'kernel.restart', 'replay.open'])
  for (const c of later) assert.match(c.unavailable ?? '', /not available until slice \d/)
  assert.equal(later.every(c => c.accelerator === undefined), true)
})

test('shortcut labels use the Mac symbols', () => {
  assert.equal(shortcutLabel('focus.terminal'), '⌘1')
  assert.equal(shortcutLabel('palette.open'), '⌘P')
  assert.equal(shortcutLabel('tab.plots'), '⇧⌘P')
  assert.equal(shortcutLabel('code.run'), '⌘↩')
  assert.equal(shortcutLabel('settings.open'), '⌘,')
  assert.equal(shortcutLabel('tab.notes'), '')
})

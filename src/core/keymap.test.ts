import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMMANDS, PANE_KEYS, commandForInput, shortcutLabel } from './keymap.ts'

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
    [{ code: 'KeyE', meta: true }, 'code.edit'],
    [{ code: 'KeyN', meta: true }, 'window.new'],
    [{ code: 'KeyW', meta: true }, 'window.close'],
    [{ code: 'KeyD', meta: true, shift: true }, 'tab.data'],
    [{ code: 'KeyP', meta: true, shift: true }, 'tab.plots'],
    [{ code: 'KeyC', meta: true, shift: true }, 'tab.code'],
    [{ code: 'KeyH', meta: true, shift: true }, 'tab.history'],
    [{ code: 'KeyT', meta: true, shift: true }, 'tab.threads'],
    [{ code: 'KeyN', meta: true, shift: true }, 'tab.notes'],
    [{ code: 'KeyF', meta: true, shift: true }, 'tab.files'],
    [{ code: 'KeyF', meta: true }, 'search.open'],
    [{ code: 'KeyR', meta: true, shift: true }, 'tab.trust'],
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

test('extra modifiers do not match: Cmd+Shift+1, Cmd+Alt+P, Cmd+Ctrl+N, Cmd+Shift+W', () => {
  assert.equal(commandForInput(input({ code: 'Digit1', meta: true, shift: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyP', meta: true, alt: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyN', meta: true, ctrl: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyW', meta: true, shift: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyD', meta: true })), undefined)
})

test('COMMANDS lists every action once, with titles', () => {
  const ids = COMMANDS.map(c => c.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of [
    'focus.terminal', 'focus.notes', 'focus.data', 'palette.open', 'code.run', 'code.edit', 'code.new', 'window.new',
    'tab.data', 'tab.plots', 'tab.code', 'tab.history', 'tab.notes', 'tab.threads', 'tab.files',
    'window.close', 'settings.open', 'pin.toggle', 'kernel.restart', 'replay.open', 'run.interrupt', 'shortcuts.show',
  ]) assert.ok(ids.includes(id as never), id)
  for (const c of COMMANDS) assert.ok(c.title.length > 0)
})

test('no two commands share an accelerator', () => {
  const keys = COMMANDS.flatMap(c => (c.accelerator ? [JSON.stringify(c.accelerator)] : []))
  assert.equal(new Set(keys).size, keys.length)
})

test('restart kernel, replay and new SQL query are palette-only commands', () => {
  for (const id of ['kernel.restart', 'replay.open', 'code.new']) {
    const command = COMMANDS.find(c => c.id === id)
    assert.ok(command, id)
    assert.equal(command.accelerator, undefined)
    assert.equal('unavailable' in command, false)
  }
})

test('Cmd+. interrupts the run', () => {
  assert.equal(commandForInput(input({ code: 'Period', meta: true })), 'run.interrupt')
  assert.equal(COMMANDS.find(c => c.id === 'run.interrupt')?.title, 'Interrupt run')
  assert.equal(shortcutLabel('run.interrupt'), '⌘.')
  assert.equal(commandForInput(input({ code: 'Period', meta: true, shift: true })), undefined)
})

test('the shortcuts overlay lists the Python keys: tables and stdout in Data, plots, and replay', () => {
  const keys = (pane: string) => PANE_KEYS.find(p => p.pane === pane)?.keys.map(([key]) => key) ?? []
  assert.ok(keys('Data').includes('[ / ]'))
  assert.ok(keys('Data').includes('s'))
  assert.ok(keys('Plots').includes('j / k'))
  for (const key of ['space', 'a', 'Enter']) assert.ok(keys('Replay').includes(key), key)
})

test('shortcut labels use the Mac symbols', () => {
  assert.equal(shortcutLabel('focus.terminal'), '⌘1')
  assert.equal(shortcutLabel('palette.open'), '⌘P')
  assert.equal(shortcutLabel('tab.plots'), '⇧⌘P')
  assert.equal(shortcutLabel('code.run'), '⌘↩')
  assert.equal(shortcutLabel('settings.open'), '⌘,')
  assert.equal(shortcutLabel('tab.threads'), '⇧⌘T')
  assert.equal(shortcutLabel('tab.notes'), '⇧⌘N')
  assert.equal(shortcutLabel('shortcuts.show'), '')
})

test('Cmd+E edits the current code', () => {
  assert.equal(shortcutLabel('code.edit'), '⌘E')
  assert.equal(COMMANDS.find(c => c.id === 'code.edit')?.title, 'Edit current code')
})

test('the shortcuts overlay lists pin in Data, Code and History, edit in Code, and the edit-mode keys', () => {
  const keys = (pane: string) => PANE_KEYS.find(p => p.pane === pane)?.keys.map(([key]) => key) ?? []
  for (const pane of ['Data', 'Code', 'History']) assert.ok(keys(pane).includes('p'), pane)
  assert.ok(keys('Code').includes('i'))
  assert.ok(keys('Code editing').includes('Esc'))
  assert.ok(keys('Code editing').includes('⌘↩'))
})

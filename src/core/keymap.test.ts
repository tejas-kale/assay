import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMMANDS, PANE_KEYS, commandForInput, paletteCommands, shortcutLabel, tabAction } from './keymap.ts'
import { TABS, defaultTabPrefs, setTabOn } from './tabs.ts'

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
    [{ code: 'Digit1', ctrl: true }, 'focus.terminal'],
    [{ code: 'Digit2', ctrl: true }, 'focus.notes'],
    [{ code: 'Digit3', ctrl: true }, 'focus.data'],
    [{ code: 'KeyP', meta: true }, 'palette.open'],
    [{ code: 'Comma', meta: true }, 'settings.open'],
    [{ code: 'Enter', meta: true }, 'code.run'],
    [{ code: 'KeyE', meta: true }, 'code.edit'],
    [{ code: 'KeyN', meta: true }, 'analysis.new'],
    [{ code: 'KeyW', meta: true }, 'analysis.close'],
    [{ code: 'KeyD', ctrl: true, shift: true }, 'tab.data'],
    [{ code: 'KeyP', ctrl: true, shift: true }, 'tab.plots'],
    [{ code: 'KeyC', ctrl: true, shift: true }, 'tab.code'],
    [{ code: 'KeyH', ctrl: true, shift: true }, 'tab.history'],
    [{ code: 'KeyT', ctrl: true, shift: true }, 'tab.threads'],
    [{ code: 'KeyN', ctrl: true, shift: true }, 'tab.notes'],
    [{ code: 'KeyF', ctrl: true, shift: true }, 'tab.files'],
    [{ code: 'KeyF', meta: true }, 'search.open'],
    [{ code: 'KeyR', ctrl: true, shift: true }, 'tab.trust'],
    [{ code: 'KeyS', ctrl: true, shift: true }, 'tab.steps'],
  ]
  for (const [over, id] of table) assert.equal(commandForInput(input(over)), id, id)
})

test('the layout does not matter: code decides, key is ignored', () => {
  assert.equal(commandForInput(input({ code: 'Digit1', key: '&', meta: true })), 'analysis.1')
  assert.equal(commandForInput(input({ code: 'Digit1', key: '&', ctrl: true })), 'focus.terminal')
  assert.equal(commandForInput(input({ code: 'KeyP', key: 'з', meta: true })), 'palette.open')
})

test('copy, paste, select-all, quit and every non-Cmd key are not claimed', () => {
  for (const code of ['KeyC', 'KeyV', 'KeyA', 'KeyQ', 'KeyX', 'KeyZ', 'KeyK']) {
    assert.equal(commandForInput(input({ code, meta: true })), undefined, code)
  }
  for (const code of ['KeyP', 'KeyN', 'KeyW', 'Enter', 'KeyD']) {
    assert.equal(commandForInput(input({ code })), undefined, code)
    assert.equal(commandForInput(input({ code, ctrl: true })), undefined, `ctrl ${code}`)
    assert.equal(commandForInput(input({ code, shift: true })), undefined, `shift ${code}`)
  }
})

test('extra modifiers do not match: Cmd+Shift+1, Cmd+Alt+P, Cmd+Ctrl+N, Cmd+Shift+W', () => {
  assert.equal(commandForInput(input({ code: 'Digit1', meta: true, shift: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyP', meta: true, alt: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyN', meta: true, ctrl: true })), undefined)
  assert.equal(commandForInput(input({ code: 'Digit1', meta: true, ctrl: true })), undefined)
  assert.equal(commandForInput(input({ code: 'Digit1', ctrl: true, alt: true })), undefined)
  assert.equal(commandForInput(input({ code: 'Digit1', ctrl: true, shift: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyW', meta: true, shift: true })), undefined)
  assert.equal(commandForInput(input({ code: 'KeyD', meta: true })), undefined)
})

test('COMMANDS lists every action once, with titles', () => {
  const ids = COMMANDS.map(c => c.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of [
    'focus.terminal', 'focus.notes', 'focus.data', 'palette.open', 'code.run', 'code.edit', 'code.new', 'analysis.new',
    'tab.data', 'tab.plots', 'tab.code', 'tab.history', 'tab.steps', 'tab.notes', 'tab.threads', 'tab.files',
    'analysis.close', 'settings.open', 'pin.toggle', 'kernel.restart', 'replay.open', 'run.interrupt', 'shortcuts.show',
  ]) assert.ok(ids.includes(id as never), id)
  for (const c of COMMANDS) assert.ok(c.title.length > 0)
})

test('no two commands share an accelerator', () => {
  const keys = COMMANDS.flatMap(c => (c.accelerator ? [JSON.stringify(c.accelerator)] : []))
  assert.equal(new Set(keys).size, keys.length)
})

test('restart kernel, replay, new SQL query and moving the strip are palette-only commands', () => {
  assert.equal(COMMANDS.find(c => c.id === 'strip.side')?.title, 'Move analysis strip: bottom / left')
  for (const id of ['kernel.restart', 'replay.open', 'code.new', 'strip.side']) {
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
  assert.equal(shortcutLabel('focus.terminal'), '⌃1')
  assert.equal(shortcutLabel('analysis.1'), '⌘1')
  assert.equal(shortcutLabel('palette.open'), '⌘P')
  assert.equal(shortcutLabel('tab.plots'), '⌃⇧P')
  assert.equal(shortcutLabel('code.run'), '⌘↩')
  assert.equal(shortcutLabel('settings.open'), '⌘,')
  assert.equal(shortcutLabel('tab.threads'), '⌃⇧T')
  assert.equal(shortcutLabel('tab.notes'), '⌃⇧N')
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

test('Cmd+1 to Cmd+9 switch to analyses 1 to 9; Ctrl+1 to Ctrl+3 focus the panes and Ctrl+4 up is not claimed', () => {
  for (let n = 1; n <= 9; n++) {
    assert.equal(commandForInput(input({ code: `Digit${n}`, meta: true })), `analysis.${n}`)
  }
  assert.equal(commandForInput(input({ code: 'Digit0', meta: true })), undefined)
  for (const n of [4, 5, 9]) assert.equal(commandForInput(input({ code: `Digit${n}`, ctrl: true })), undefined, `ctrl ${n}`)
  assert.equal(commandForInput(input({ code: 'KeyP', ctrl: true })), undefined)
})

test('the pane keys name Ctrl+2 for cycling the notes tabs', () => {
  const keys = PANE_KEYS.flatMap(p => p.keys.map(([key]) => key))
  assert.ok(keys.includes('⌃2 again'))
  assert.ok(!keys.includes('⌘2 again'))
})

test('every pane shortcut uses Ctrl: Ctrl+1..3 focus a pane, Ctrl+Shift+letter shows a tab, and Cmd+Shift+letter no longer does', () => {
  for (const c of COMMANDS.filter(c => c.id.startsWith('focus.') || c.id.startsWith('tab.') || c.id === 'terminal.zoom')) {
    const a = c.accelerator
    assert.ok(a, c.id)
    assert.equal(a.ctrl, true, c.id)
    if (c.id.startsWith('tab.')) assert.equal(commandForInput(input({ code: a.code, shift: true, meta: true })), undefined, `cmd ${c.id}`)
  }
  assert.equal(commandForInput(input({ code: 'KeyC', ctrl: true })), undefined, 'Ctrl+C stays with the terminal')
  assert.equal(shortcutLabel('tab.code'), '⌃⇧C')
})

test('Ctrl+0 zooms the terminal to the whole analysis and back; Cmd+0 stays free', () => {
  assert.equal(commandForInput(input({ code: 'Digit0', ctrl: true })), 'terminal.zoom')
  assert.equal(commandForInput(input({ code: 'Digit0', meta: true })), undefined)
  assert.equal(shortcutLabel('terminal.zoom'), '⌃0')
  assert.equal(COMMANDS.find(c => c.id === 'terminal.zoom')?.title, 'Zoom terminal / restore panes')
})

test('Restart to update is in the palette only while an update is ready', () => {
  const titles = (isUpdateReady: boolean) => paletteCommands({ isUpdateReady }).map(c => c.title)
  assert.ok(titles(true).includes('Restart to update'))
  assert.ok(!titles(false).includes('Restart to update'))
  assert.equal(titles(false).length, COMMANDS.length - 1)
})

test('every tab in the registry has its Show command on Ctrl+Shift and its own key', () => {
  for (const tab of TABS) {
    const command = COMMANDS.find(c => c.id === `tab.${tab.id}`)
    assert.ok(command, tab.id)
    assert.equal(command.title, `Show ${tab.title} tab`)
    assert.deepEqual(command.accelerator, { code: tab.shortcut, shift: true, ctrl: true })
  }
  const tabKeys = COMMANDS.filter(c => c.id.startsWith('tab.')).map(c => c.accelerator?.code)
  assert.equal(new Set(tabKeys).size, TABS.length)
})

test('a tab command shows its tab while it is on, and resolves to the toast while it is off', () => {
  const prefs = setTabOn(defaultTabPrefs(), 'trust', false)
  assert.deepEqual(tabAction('tab.code', prefs), { type: 'show', tab: 'code', pane: 'data' })
  assert.deepEqual(tabAction('tab.threads', prefs), { type: 'show', tab: 'threads', pane: 'notes' })
  assert.deepEqual(tabAction('tab.trust', prefs), { type: 'toast', text: 'Trust tab is off: Settings (⌘,)' })
})

test('focusing a pane whose tabs are all off resolves to the toast; other commands are not tab actions', () => {
  let prefs = defaultTabPrefs()
  for (const id of ['data', 'plots', 'code', 'history', 'steps', 'trust'] as const) prefs = setTabOn(prefs, id, false)
  assert.deepEqual(tabAction('focus.data', prefs), { type: 'toast', text: 'Every Data pane tab is off: Settings (⌘,)' })
  assert.equal(tabAction('focus.notes', prefs), undefined)
  assert.equal(tabAction('palette.open', prefs), undefined)
})

test('a command that opens Code toasts while Code is off; one aimed at the data pane toasts while that pane is hidden', () => {
  const codeOff = setTabOn(defaultTabPrefs(), 'code', false)
  assert.deepEqual(tabAction('code.edit', codeOff), { type: 'toast', text: 'Code tab is off: Settings (⌘,)' })
  assert.deepEqual(tabAction('code.new', codeOff), { type: 'toast', text: 'Code tab is off: Settings (⌘,)' })
  assert.equal(tabAction('code.edit', defaultTabPrefs()), undefined)
  let hidden = defaultTabPrefs()
  for (const id of ['data', 'plots', 'code', 'history', 'steps', 'trust'] as const) hidden = setTabOn(hidden, id, false)
  for (const id of ['code.run', 'pin.toggle', 'run.interrupt', 'kernel.restart', 'replay.open'] as const) {
    assert.deepEqual(tabAction(id, hidden), { type: 'toast', text: 'Every Data pane tab is off: Settings (⌘,)' }, id)
  }
})

test('the shortcuts overlay names ⌃2 and ⌃3 again as the next tab in every tab of their pane, never a fixed one', () => {
  const again = (pane: string) => PANE_KEYS.find(p => p.pane === pane)?.keys.find(([key]) => key.endsWith('again'))
  for (const pane of ['Overview', 'Threads', 'Notes', 'Files']) assert.deepEqual(again(pane), ['⌃2 again', 'next tab'], pane)
  for (const pane of ['Data', 'Plots', 'Code', 'History', 'Steps', 'Trust']) assert.deepEqual(again(pane), ['⌃3 again', 'next tab'], pane)
})

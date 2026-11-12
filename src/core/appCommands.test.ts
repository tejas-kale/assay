import assert from 'node:assert/strict'
import { test } from 'node:test'

import { closePaletteEffects, closeSearchEffects, closeSettingsEffects, cycledTab, guardTab, hitEffects, planCommand, restoreFocus, showReviewEffects } from './appCommands.ts'
import type { CommandContext, Effect } from './appCommands.ts'
import { defaultTabPrefs } from './tabs.ts'
import type { TabPrefs } from './tabs.ts'

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  tabs: defaultTabPrefs(),
  inWorkspace: true,
  pythonRunning: false,
  activePane: 'terminal',
  palette: undefined,
  search: undefined,
  settings: undefined,
  needsFolder: false,
  ...over,
})

const off = (...ids: string[]): TabPrefs => {
  const prefs = defaultTabPrefs()
  return { notes: prefs.notes.map(t => ({ ...t, on: !ids.includes(t.id) })), data: prefs.data.map(t => ({ ...t, on: !ids.includes(t.id) })) }
}

const effects = (id: Parameters<typeof planCommand>[0], over: Partial<CommandContext> = {}) => planCommand(id, ctx(over))
const focus = (pane: 'terminal' | 'notes' | 'data'): Effect => ({ type: 'focus', pane })

test('showing a tab that is on opens it and focuses its pane; one that is off says so', () => {
  assert.deepEqual(effects('tab.notes'), { effects: [{ type: 'notes-tab', tab: 'notes' }, focus('notes')], movedFocus: true })
  assert.deepEqual(effects('tab.history'), { effects: [{ type: 'data-tab', tab: 'history' }, focus('data')], movedFocus: true })
  const result = effects('tab.notes', { tabs: off('notes') })
  assert.equal(result.movedFocus, false)
  assert.equal(result.effects[0]?.type, 'toast')
})

test('focusing a pane from outside moves there; again from inside it cycles its tabs first', () => {
  assert.deepEqual(effects('focus.terminal'), { effects: [focus('terminal')], movedFocus: true })
  assert.deepEqual(effects('focus.notes').effects, [focus('notes')])
  assert.deepEqual(effects('focus.notes', { activePane: 'notes' }).effects, [{ type: 'cycle-tab', pane: 'notes' }, focus('notes')])
  assert.deepEqual(effects('focus.data', { activePane: 'data' }).effects, [{ type: 'cycle-tab', pane: 'data' }, focus('data')])
})

test('zoom needs an analysis and then focuses the terminal', () => {
  assert.deepEqual(effects('terminal.zoom'), { effects: [{ type: 'toggle-zoom' }, focus('terminal')], movedFocus: true })
  assert.deepEqual(effects('terminal.zoom', { inWorkspace: false }), { effects: [], movedFocus: false })
})

test('the shortcuts overlay leaves the focus alone', () => {
  assert.deepEqual(effects('shortcuts.show'), { effects: [{ type: 'show-shortcuts' }], movedFocus: false })
})

test('Settings replaces the palette or the search and returns to where they came from', () => {
  const closing: Effect[] = [{ type: 'palette', value: undefined }, { type: 'search', value: undefined }]
  assert.deepEqual(effects('settings.open', { activePane: 'data' }).effects, [...closing, { type: 'settings', value: { returnTo: 'data' } }])
  assert.deepEqual(effects('settings.open', { palette: { returnTo: 'notes' } }).effects.at(-1), { type: 'settings', value: { returnTo: 'notes' } })
  assert.deepEqual(effects('settings.open', { search: { returnTo: undefined }, activePane: 'data' }).effects.at(-1), { type: 'settings', value: { returnTo: undefined } })
  assert.deepEqual(effects('settings.open', { settings: { returnTo: 'data' } }).effects, closing)
})

test('the palette opens over the search, takes its way back, and toggles off to where it came from', () => {
  assert.deepEqual(effects('palette.open', { activePane: 'data' }).effects, [{ type: 'search', value: undefined }, { type: 'palette', value: { returnTo: 'data' } }])
  assert.deepEqual(effects('palette.open', { search: { returnTo: 'notes' } }).effects.at(-1), { type: 'palette', value: { returnTo: 'notes' } })
  assert.deepEqual(effects('palette.open', { palette: { returnTo: 'notes' } }).effects, [{ type: 'palette', value: undefined }, focus('notes')])
  assert.deepEqual(effects('palette.open', { palette: { returnTo: undefined } }).effects, [{ type: 'palette', value: undefined }, { type: 'focus-picker' }])
})

test('the palette stays shut under Settings, and while Settings needs a folder', () => {
  assert.deepEqual(effects('palette.open', { settings: { returnTo: undefined } }), { effects: [], movedFocus: true })
  assert.deepEqual(effects('palette.open', { needsFolder: true }), { effects: [], movedFocus: true })
})

test('search needs an analysis, stays shut under Settings, and toggles off to where it came from', () => {
  assert.deepEqual(effects('search.open', { inWorkspace: false }), { effects: [{ type: 'toast', text: 'Open an analysis first.' }], movedFocus: false })
  assert.deepEqual(effects('search.open', { settings: { returnTo: undefined } }), { effects: [], movedFocus: true })
  assert.deepEqual(effects('search.open', { search: { returnTo: 'data' } }).effects, [{ type: 'search', value: undefined }, focus('data')])
  assert.deepEqual(effects('search.open', { search: { returnTo: undefined } }).effects, [{ type: 'search', value: undefined }])
})

test('search opens over the palette, taking its way back', () => {
  assert.deepEqual(effects('search.open', { activePane: 'notes' }).effects, [{ type: 'palette', value: undefined }, { type: 'search', value: { returnTo: 'notes' } }])
  assert.deepEqual(effects('search.open', { palette: { returnTo: 'data' } }).effects.at(-1), { type: 'search', value: { returnTo: 'data' } })
})

test('data commands go to the data pane, some after checking the state', () => {
  assert.deepEqual(effects('code.run'), { effects: [{ type: 'data-command', id: 'code.run' }], movedFocus: false })
  assert.deepEqual(effects('pin.toggle').effects, [{ type: 'data-command', id: 'pin.toggle' }])
  assert.deepEqual(effects('run.interrupt', { pythonRunning: true }), { effects: [{ type: 'data-command', id: 'run.interrupt' }, focus('data')], movedFocus: true })
  assert.deepEqual(effects('run.interrupt'), { effects: [{ type: 'toast', text: 'Nothing is running.' }], movedFocus: false })
  assert.deepEqual(effects('kernel.restart').effects, [{ type: 'data-command', id: 'kernel.restart' }, focus('data')])
  assert.deepEqual(effects('replay.open').effects, [{ type: 'data-command', id: 'replay.open' }, focus('data')])
  assert.deepEqual(effects('code.edit'), { effects: [{ type: 'unzoom' }, { type: 'data-command', id: 'code.edit' }], movedFocus: true })
  assert.deepEqual(effects('code.new').effects, [{ type: 'unzoom' }, { type: 'data-command', id: 'code.new' }])
})

test('restart, replay and rename need an analysis', () => {
  for (const id of ['kernel.restart', 'replay.open', 'analysis.rename'] as const) {
    assert.deepEqual(effects(id, { inWorkspace: false }), { effects: [{ type: 'toast', text: 'Open an analysis first.' }], movedFocus: false })
  }
  assert.deepEqual(effects('analysis.rename'), { effects: [{ type: 'rename' }], movedFocus: true })
})

test('window commands call main without moving the focus', () => {
  assert.deepEqual(effects('analysis.new'), { effects: [{ type: 'window', call: 'new-window' }], movedFocus: false })
  assert.deepEqual(effects('analysis.close').effects, [{ type: 'window', call: 'close-window' }])
  assert.deepEqual(effects('strip.side').effects, [{ type: 'window', call: 'toggle-strip-side' }])
  assert.deepEqual(effects('update.restart').effects, [{ type: 'window', call: 'restart-update' }])
})

test('Cmd+N shows analysis N, and an unknown command does nothing', () => {
  assert.deepEqual(effects('analysis.3'), { effects: [{ type: 'show-analysis', number: 3 }], movedFocus: false })
  assert.deepEqual(planCommand('nothing' as never, ctx()), { effects: [], movedFocus: false })
})

test('the next tab that is on follows, wrapping, and a pane with no other keeps its tab', () => {
  assert.equal(cycledTab(defaultTabPrefs(), 'notes', 'overview'), 'threads')
  assert.equal(cycledTab(defaultTabPrefs(), 'notes', 'files'), 'overview')
  assert.equal(cycledTab(off('threads', 'notes', 'files'), 'notes', 'overview'), 'overview')
  assert.equal(cycledTab(off('overview'), 'notes', 'overview'), 'notes')
})

test('a request for a tab that is off becomes its toast', () => {
  const asked: Effect[] = [{ type: 'data-tab', tab: 'trust' }]
  assert.deepEqual(guardTab(defaultTabPrefs(), 'trust', asked), asked)
  assert.equal(guardTab(off('trust'), 'trust', asked)[0]?.type, 'toast')
  assert.deepEqual(showReviewEffects(defaultTabPrefs()), asked)
  assert.equal(showReviewEffects(off('trust'))[0]?.type, 'toast')
})

test('a search hit shows in its own tab', () => {
  const closed: Effect = { type: 'search', value: undefined }
  assert.deepEqual(hitEffects({ kind: 'run', number: 4 }, defaultTabPrefs()), [closed, { type: 'show-run', number: 4 }, focus('data')])
  const thread = { kind: 'thread', closed: false, index: 0 } as const
  assert.deepEqual(hitEffects(thread, defaultTabPrefs()), [closed, { type: 'notes-tab', tab: 'threads' }, { type: 'reveal', target: thread }, focus('notes')])
  assert.equal((hitEffects({ kind: 'file', path: 'a' }, defaultTabPrefs())[1] as { tab: string }).tab, 'files')
  assert.equal((hitEffects({ kind: 'note', name: 'a' }, defaultTabPrefs())[1] as { tab: string }).tab, 'notes')
})

test('a search hit in a tab that is off closes the search and says so', () => {
  const result = hitEffects({ kind: 'run', number: 1 }, off('data'))
  assert.equal(result.length, 2)
  assert.deepEqual(result[0], { type: 'search', value: undefined })
  assert.equal(result[1]?.type, 'toast')
})

test('the focus goes back to a pane, or to the picker', () => {
  assert.deepEqual(restoreFocus('data'), focus('data'))
  assert.deepEqual(restoreFocus(undefined), { type: 'focus-picker' })
})

test('closing Settings or the palette restores the focus; closing the search only when it had a pane', () => {
  assert.deepEqual(closeSettingsEffects({ returnTo: 'notes' }), [{ type: 'settings', value: undefined }, focus('notes')])
  assert.deepEqual(closeSettingsEffects(undefined), [{ type: 'settings', value: undefined }, { type: 'focus-picker' }])
  assert.deepEqual(closePaletteEffects({ returnTo: 'data' }, true), [{ type: 'palette', value: undefined }, focus('data')])
  assert.deepEqual(closePaletteEffects({ returnTo: 'data' }, false), [{ type: 'palette', value: undefined }])
  assert.deepEqual(closeSearchEffects({ returnTo: 'data' }), [{ type: 'search', value: undefined }, focus('data')])
  assert.deepEqual(closeSearchEffects({ returnTo: undefined }), [{ type: 'search', value: undefined }])
  assert.deepEqual(closeSearchEffects(undefined), [{ type: 'search', value: undefined }])
})

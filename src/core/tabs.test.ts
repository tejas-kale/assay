import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TABS, defaultTabPrefs, hitTab, isPaneHidden, isTabOn, markTabs, moveTab, nextTab, paneOffText, parseTabPrefs, setTabOn, shownTab, tabOffText, tabsOf, visibleTabs } from './tabs.ts'
import type { Seen, TabPrefs } from './tabs.ts'

test('every tab has a unique id and a unique shortcut', () => {
  assert.equal(new Set(TABS.map(t => t.id)).size, TABS.length)
  assert.equal(new Set(TABS.map(t => t.shortcut)).size, TABS.length)
})

test('the default order of each pane', () => {
  assert.deepEqual(tabsOf('notes'), ['overview', 'threads', 'notes', 'files'])
  assert.deepEqual(tabsOf('data'), ['data', 'plots', 'code', 'history', 'steps', 'trust'])
})

const seen = (over: Partial<Seen> = {}): Seen => ({ number: 1, code: '001_a.sql', data: '001_a.csv', failed: false, runCount: 1, plots: [], ...over })
const none = new Set<string>()
const sorted = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b))

test('a new run marks Data, Code and History, except the tab on screen', () => {
  const after = seen({ number: 2, code: '002_b.sql', data: '002_b.csv', runCount: 2 })
  assert.deepEqual(sorted(markTabs(none, seen(), after, 'plots')), ['code', 'data', 'history'])
  assert.deepEqual(sorted(markTabs(none, seen(), after, 'data')), ['code', 'history'])
})

test('a result arriving for the same run marks Data only', () => {
  assert.deepEqual([...markTabs(none, seen({ data: undefined }), seen(), 'code')], ['data'])
})

test('a failure marks Data', () => {
  assert.deepEqual([...markTabs(none, seen(), seen({ failed: true }), 'history')], ['data'])
})

test('an unchanged snapshot keeps the markers it had, and showing a tab clears its marker', () => {
  const held = new Set(['data', 'history'])
  assert.deepEqual(sorted(markTabs(held, seen(), seen(), 'code')), ['data', 'history'])
  assert.deepEqual([...markTabs(held, seen(), seen(), 'data')], ['history'])
})

test('a shrinking run count does not mark History', () => {
  assert.deepEqual([...markTabs(none, seen({ runCount: 3 }), seen({ runCount: 2 }), 'data')], [])
})

test('markTabs does not change the set it was given', () => {
  const held = new Set<string>()
  markTabs(held, seen(), seen({ runCount: 2 }), 'data')
  assert.equal(held.size, 0)
})

test('plots changing for the current run marks Plots, unless Plots is on screen', () => {
  const after = seen({ plots: ['001_a.p1.png'] })
  assert.deepEqual([...markTabs(none, seen(), after, 'data')], ['plots'])
  assert.deepEqual([...markTabs(none, seen(), after, 'plots')], [])
  assert.deepEqual([...markTabs(none, after, after, 'data')], [])
  assert.deepEqual([...markTabs(none, after, seen({ plots: ['001_a.p1.png', '001_a.p2.png'] }), 'code')], ['plots'])
})

test('a changed trust review marks Trust, except while it is shown', () => {
  const after = seen({ trust: '100:asking:3' })
  assert.deepEqual([...markTabs(none, seen({ trust: '100:checking:1' }), after, 'data')], ['trust'])
  assert.deepEqual([...markTabs(none, seen({ trust: '100:checking:1' }), after, 'trust')], [])
  assert.deepEqual([...markTabs(none, seen(), seen(), 'data')], [])
})

test('Steps is never marked: Data and Code already mark the run it draws', () => {
  const after = seen({ number: 2, code: '002_b.sql', data: '002_b.csv', runCount: 2, plots: ['x.png'], trust: 't' })
  assert.equal(markTabs(none, seen(), after, 'data').has('steps'), false)
})

const prefs = (notes: [string, boolean][], data: [string, boolean][] = []) => ({
  notes: notes.map(([id, on]) => ({ id, on })),
  data: data.map(([id, on]) => ({ id, on })),
}) as TabPrefs

test('the default preferences hold every tab, on, in default order', () => {
  const d = defaultTabPrefs()
  assert.deepEqual(d.notes.map(t => t.id), tabsOf('notes'))
  assert.deepEqual(d.data.map(t => t.id), tabsOf('data'))
  assert.ok([...d.notes, ...d.data].every(t => t.on))
})

test('parsed preferences keep the saved order and switches', () => {
  const parsed = parseTabPrefs({ notes: [{ id: 'files', on: false }, { id: 'overview', on: true }, { id: 'threads', on: true }, { id: 'notes', on: true }] })
  assert.deepEqual(parsed.notes, [{ id: 'files', on: false }, { id: 'overview', on: true }, { id: 'threads', on: true }, { id: 'notes', on: true }])
  assert.deepEqual(parsed.data, defaultTabPrefs().data)
})

test('parsing drops unknown ids, ids of the other pane and repeats, and appends a missing tab at the end, on', () => {
  const parsed = parseTabPrefs({ notes: [{ id: 'gone', on: true }, { id: 'data', on: false }, { id: 'notes', on: false }, { id: 'notes', on: true }] })
  assert.deepEqual(parsed.notes, [{ id: 'notes', on: false }, { id: 'overview', on: true }, { id: 'threads', on: true }, { id: 'files', on: true }])
})

test('anything malformed gives the defaults', () => {
  for (const raw of [undefined, null, 5, 'x', [], { notes: 'x' }, { notes: [5, null, { id: 3 }] }]) {
    assert.deepEqual(parseTabPrefs(raw), defaultTabPrefs(), JSON.stringify(raw))
  }
  assert.deepEqual(parseTabPrefs({ notes: [{ id: 'files', on: 'yes' }] }).notes[0], { id: 'files', on: true })
})

test('a pane shows its tabs that are on, in the chosen order', () => {
  const p = prefs([['files', true], ['overview', false], ['threads', true], ['notes', true]])
  assert.deepEqual(visibleTabs(p, 'notes'), ['files', 'threads', 'notes'])
  assert.equal(isTabOn(p, 'overview'), false)
  assert.equal(isTabOn(p, 'files'), true)
})

test('Ctrl+2 cycles to the next tab that is on, past off tabs, and wraps', () => {
  const p = prefs([['overview', true], ['threads', false], ['notes', true], ['files', false]])
  assert.equal(nextTab(p, 'notes', 'overview'), 'notes')
  assert.equal(nextTab(p, 'notes', 'notes'), 'overview')
  // From a tab just turned off, the next one on.
  assert.equal(nextTab(p, 'notes', 'threads'), 'notes')
  assert.equal(nextTab(prefs([['overview', false], ['threads', false], ['notes', false], ['files', false]]), 'notes', 'notes'), undefined)
})

test('the tab a pane shows: the chosen one while it is on, else the first one on', () => {
  const p = prefs([['overview', false], ['threads', true], ['notes', true], ['files', true]])
  assert.equal(shownTab(p, 'notes', 'notes'), 'notes')
  assert.equal(shownTab(p, 'notes', 'overview'), 'threads')
})

test('a pane with every tab off is hidden', () => {
  assert.equal(isPaneHidden(prefs([['overview', false], ['threads', false], ['notes', false], ['files', false]]), 'notes'), true)
  assert.equal(isPaneHidden(prefs([['overview', false], ['threads', false], ['notes', false], ['files', true]]), 'notes'), false)
})

test('moving a tab swaps it with its neighbour, and stops at the ends', () => {
  const d = defaultTabPrefs()
  assert.deepEqual(moveTab(d, 'threads', -1).notes.map(t => t.id), ['threads', 'overview', 'notes', 'files'])
  assert.deepEqual(moveTab(d, 'threads', 1).notes.map(t => t.id), ['overview', 'notes', 'threads', 'files'])
  assert.deepEqual(moveTab(d, 'overview', -1), d)
  assert.deepEqual(moveTab(d, 'trust', 1), d)
})

test('switching a tab off and on', () => {
  const off = setTabOn(defaultTabPrefs(), 'plots', false)
  assert.equal(isTabOn(off, 'plots'), false)
  assert.equal(isTabOn(setTabOn(off, 'plots', true), 'plots'), true)
  assert.equal(isTabOn(defaultTabPrefs(), 'plots'), true)
})

test('the toasts name the tab or the pane, and Settings', () => {
  assert.equal(tabOffText('trust'), 'Trust tab is off: Settings (⌘,)')
  assert.equal(paneOffText('data'), 'Every Data pane tab is off: Settings (⌘,)')
  assert.equal(paneOffText('notes'), 'Every Notes pane tab is off: Settings (⌘,)')
})

test('a search hit shows in its own tab: threads, notes and files in theirs, a run in Data', () => {
  assert.deepEqual((['thread', 'note', 'file', 'run'] as const).map(hitTab), ['threads', 'notes', 'files', 'data'])
})

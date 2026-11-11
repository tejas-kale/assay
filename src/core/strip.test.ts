import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_STRIP, TITLE_CHARS, isStripShown, parseStripPrefs, runDuration, shortTitle, stripEntry } from './strip.ts'

const SHOW = DEFAULT_STRIP.show

const base = { number: 2, title: 'Buyer ratings', claude: 'working' as const, sessionLive: true, running: undefined, current: false }
const NOW = 1_000_000_000

test('an entry carries its number, title, Claude state and whether it is the one shown', () => {
  assert.deepEqual(stripEntry(base, NOW, SHOW), { number: 2, title: 'Buyer ratings', label: 'Buyer ratings', state: 'working', current: false })
  assert.equal(stripEntry({ ...base, claude: 'waiting', current: true }, NOW, SHOW).state, 'waiting')
  assert.equal(stripEntry({ ...base, current: true }, NOW, SHOW).current, true)
})

test('an analysis whose Claude session has ended shows ended, whatever the last hook said', () => {
  assert.equal(stripEntry({ ...base, sessionLive: false }, NOW, SHOW).state, 'ended')
})

test('a run in progress shows its number and how long it has run', () => {
  const entry = stripEntry({ ...base, running: { number: 12, startedAt: NOW - 125_000 } }, NOW, SHOW)
  assert.deepEqual(entry.run, { number: 12, duration: '2:05' })
})

test('run durations read m:ss under an hour and h:mm:ss after; a start in the future reads 0:00', () => {
  assert.equal(runDuration(NOW - 7_000, NOW), '0:07')
  assert.equal(runDuration(NOW - 3_723_000, NOW), '1:02:03')
  assert.equal(runDuration(NOW + 5_000, NOW), '0:00')
})

test('titles longer than the strip allows are cut on a word where one is near, with an ellipsis', () => {
  assert.equal(TITLE_CHARS, 24)
  assert.equal(shortTitle('Buyer ratings', 24), 'Buyer ratings')
  assert.equal(shortTitle('Buyer ratings metric validation for Q4', 24), 'Buyer ratings metric…')
  assert.equal(shortTitle('Supercalifragilisticexpialidocious', 24), 'Supercalifragilisticexp…')
  assert.equal(stripEntry({ ...base, title: 'Buyer ratings metric validation for Q4' }, NOW, SHOW).label, 'Buyer ratings metric…')
})

test('no state is put in words: the icon alone shows it', () => {
  for (const claude of ['working', 'waiting', 'idle'] as const) assert.equal('stateText' in stripEntry({ ...base, claude }, NOW, SHOW), false)
  assert.equal('stateText' in stripEntry({ ...base, sessionLive: false }, NOW, SHOW), false)
})

test('by default the strip sits at the bottom and shows title, state and run, not the number, and never hides', () => {
  assert.deepEqual(DEFAULT_STRIP, { side: 'bottom', show: { title: true, state: true, run: true, number: false }, autoHide: false })
})

test('each part of an entry shows only while its setting is on', () => {
  const facts = { ...base, running: { number: 12, startedAt: NOW - 1000 } }
  const bare = stripEntry(facts, NOW, { title: false, state: false, run: false, number: false })
  assert.equal(bare.label, undefined)
  assert.equal(bare.state, undefined)
  assert.equal(bare.run, undefined)
  assert.equal(bare.key, undefined)
  // The full title stays for the tooltip.
  assert.equal(bare.title, 'Buyer ratings')
  assert.equal(stripEntry(facts, NOW, { ...SHOW, number: true }).key, '⌘2')
})

test('auto-hide hides the strip while one analysis is open, and only then', () => {
  const on = { ...DEFAULT_STRIP, autoHide: true }
  assert.equal(isStripShown(on, 1), false)
  assert.equal(isStripShown(on, 0), false)
  assert.equal(isStripShown(on, 2), true)
  assert.equal(isStripShown(DEFAULT_STRIP, 1), true)
})

test('saved strip settings read back; anything malformed falls back to its default, part by part', () => {
  const saved = { side: 'left', show: { title: false, state: true, run: false, number: true }, autoHide: true }
  assert.deepEqual(parseStripPrefs(saved), saved)
  for (const raw of [undefined, null, 5, [], {}, { side: 'top', show: 'x', autoHide: 'yes' }]) {
    assert.deepEqual(parseStripPrefs(raw), DEFAULT_STRIP, JSON.stringify(raw))
  }
  assert.deepEqual(parseStripPrefs({ show: { number: true } }).show, { title: true, state: true, run: true, number: true })
})

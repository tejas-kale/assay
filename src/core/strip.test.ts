import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TITLE_CHARS, runDuration, shortTitle, stripEntry } from './strip.ts'

const base = { number: 2, title: 'Buyer ratings', claude: 'working' as const, sessionLive: true, running: undefined, current: false }
const NOW = 1_000_000_000

test('an entry carries its number, title, Claude state and whether it is the one shown', () => {
  assert.deepEqual(stripEntry(base, NOW), { number: 2, title: 'Buyer ratings', label: 'Buyer ratings', state: 'working', current: false })
  assert.equal(stripEntry({ ...base, claude: 'waiting', current: true }, NOW).state, 'waiting')
  assert.equal(stripEntry({ ...base, current: true }, NOW).current, true)
})

test('an analysis whose Claude session has ended shows ended, whatever the last hook said', () => {
  assert.equal(stripEntry({ ...base, sessionLive: false }, NOW).state, 'ended')
})

test('a run in progress shows its number and how long it has run', () => {
  const entry = stripEntry({ ...base, running: { number: 12, startedAt: NOW - 125_000 } }, NOW)
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
  assert.equal(stripEntry({ ...base, title: 'Buyer ratings metric validation for Q4' }, NOW).label, 'Buyer ratings metric…')
})

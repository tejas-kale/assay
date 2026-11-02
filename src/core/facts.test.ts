import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StaleEdit } from './errors.ts'
import { citedLabel, parseRuns } from './runs.ts'
import {
  addFact,
  deleteFact,
  editFact,
  fileNoteLine,
  listFacts,
  notesFrom,
  notesText,
  parseFileNote,
  parseNote,
} from './facts.ts'

const labels = (names: string[], status: Record<number, 'ok' | 'error'> = {}) =>
  citedLabel(parseRuns(names).map(r => (status[r.number] ? { ...r, status: status[r.number] } : r)))
const QUERIES = labels(['001_first.sql', '001_first.csv', '002_second.sql', '012_third.sql', '012_third.csv'])

// Ported from the mod's tests/model.test.ts.
test('a note splits off its label and query; an old line has a query or nothing', () => {
  assert.deepEqual(parseNote('beta is per panel [queried q 007]'), { text: 'beta is per panel', label: 'queried', query: 7 })
  assert.deepEqual(parseNote('beta [trusted q 012]'), { text: 'beta', label: 'trusted', query: 12 })
  assert.deepEqual(parseNote('beta [unverified]'), { text: 'beta', label: 'unverified' })
  assert.deepEqual(parseNote('beta is per panel [q 007]'), { text: 'beta is per panel', query: 7 })
  assert.deepEqual(parseNote('beta is per panel'), { text: 'beta is per panel' })
  assert.deepEqual(parseNote('beta [trusted]'), { text: 'beta [trusted]' })
})

test('a note file is linked from notes.md by its title and path', () => {
  const line = fileNoteLine('Why [alpha] is 0', '/repos/llm-wiki/data (old)/alpha.md')
  assert.equal(line, '[Why alpha is 0](</repos/llm-wiki/data (old)/alpha.md>)')
  assert.deepEqual(parseFileNote(line), { title: 'Why alpha is 0', path: '/repos/llm-wiki/data (old)/alpha.md' })
  assert.equal(parseFileNote('see [docs](https://example.com)'), undefined)
})

test('notesFrom drops blank lines and notesText ends each line with a newline', () => {
  assert.deepEqual(notesFrom('a\n\n  \nb\n'), ['a', 'b'])
  assert.equal(notesText(['a', 'b']), 'a\nb\n')
})

test('listFacts gives index, line, text, label, query and file notes', () => {
  const text = 'beta [queried q 001]\n\n[Alpha](<notes/alpha.md>)\nold [q 002]\nplain\n'
  assert.deepEqual(listFacts(text), [
    { index: 0, line: 'beta [queried q 001]', text: 'beta', label: 'queried', query: 1 },
    { index: 1, line: '[Alpha](<notes/alpha.md>)', text: 'Alpha', file: { title: 'Alpha', path: 'notes/alpha.md' } },
    { index: 2, line: 'old [q 002]', text: 'old', query: 2 },
    { index: 3, line: 'plain', text: 'plain' },
  ])
})

test('addFact derives the label: queried with a .csv, else unverified', () => {
  assert.equal(addFact('', 'beta is per panel [q 1]', QUERIES), 'beta is per panel [queried q 001]\n')
  assert.equal(addFact('', 'beta [q 2]', QUERIES), 'beta [unverified q 002]\n')
  assert.equal(addFact('', 'beta [q 99]', QUERIES), 'beta [unverified q 099]\n')
  assert.equal(addFact('', 'beta', QUERIES), 'beta [unverified]\n')
})

test('addFact ignores the label typed, and never grants trusted', () => {
  assert.equal(addFact('', 'beta [trusted q 12]', QUERIES), 'beta [queried q 012]\n')
  assert.equal(addFact('', 'beta [trusted q 2]', QUERIES), 'beta [unverified q 002]\n')
})

test('addFact collapses newlines, appends, and refuses empty input', () => {
  assert.equal(addFact('a [unverified]\n', ' b\nc  [q 1] ', QUERIES), 'a [unverified]\nb c [queried q 001]\n')
  assert.throws(() => addFact('', '  \n ', QUERIES), /empty/i)
  assert.throws(() => addFact('', '[q 1]', QUERIES), /empty/i)
})

test('editFact replaces the line and re-derives the label', () => {
  const text = 'a [unverified]\nb [queried q 001]\n'
  assert.equal(editFact(text, 0, 'a [unverified]', 'a2 [q 12]', QUERIES), 'a2 [queried q 012]\nb [queried q 001]\n')
})

test('editFact without a tag keeps the existing citation', () => {
  const text = 'b [queried q 001]\nc [unverified q 002]\n'
  assert.equal(editFact(text, 0, 'b [queried q 001]', 'b changed', QUERIES), 'b changed [queried q 001]\nc [unverified q 002]\n')
  assert.equal(editFact(text, 1, 'c [unverified q 002]', 'c changed', QUERIES), 'b [queried q 001]\nc changed [unverified q 002]\n')
})

test('editFact with an explicit empty tag drops the citation', () => {
  assert.equal(editFact('b [queried q 001]\n', 0, 'b [queried q 001]', 'b [unverified]', QUERIES), 'b [unverified]\n')
})

test('editFact keeps trusted only for the same query whose .csv still exists', () => {
  const text = 'b [trusted q 012]\n'
  const old = 'b [trusted q 012]'
  assert.equal(editFact(text, 0, old, 'b2', QUERIES), 'b2 [trusted q 012]\n')
  assert.equal(editFact(text, 0, old, 'b2 [q 12]', QUERIES), 'b2 [trusted q 012]\n')
  assert.equal(editFact(text, 0, old, 'b2 [trusted q 12]', QUERIES), 'b2 [trusted q 012]\n')
  assert.equal(editFact(text, 0, old, 'b2 [q 1]', QUERIES), 'b2 [queried q 001]\n')
  assert.equal(editFact(text, 0, old, 'b2', labels(['012_third.sql'])), 'b2 [unverified q 012]\n')
})

test('editFact returns the text unchanged when text and citation are unchanged', () => {
  const trusted = '\nb [trusted q 012]\n\n'
  assert.equal(editFact(trusted, 0, 'b [trusted q 012]', 'b', labels(['012_x.sql'])), trusted)
  assert.equal(editFact(trusted, 0, 'b [trusted q 012]', 'b [q 12]', labels(['012_x.sql'])), trusted)
  const plain = 'a [queried q 001]\n'
  assert.equal(editFact(plain, 0, 'a [queried q 001]', 'a', labels(['001_x.sql'])), plain)
  const untagged = 'plain note\n'
  assert.equal(editFact(untagged, 0, 'plain note', 'plain note', QUERIES), untagged)
})

test('editFact throws StaleEdit when the line changed, and refuses file notes and empty input', () => {
  assert.throws(() => editFact('a [unverified]\n', 0, 'other', 'x', QUERIES), StaleEdit)
  assert.throws(() => editFact('a [unverified]\n', 3, 'a [unverified]', 'x', QUERIES), StaleEdit)
  const link = '[Alpha](<notes/alpha.md>)'
  assert.throws(() => editFact(`${link}\n`, 0, link, 'x', QUERIES), (e: Error) => !(e instanceof StaleEdit) && /file note/i.test(e.message))
  assert.throws(() => editFact('a [unverified]\n', 0, 'a [unverified]', ' ', QUERIES), /empty/i)
})

test('deleteFact removes only that line, also for a file note', () => {
  const link = '[Alpha](<notes/alpha.md>)'
  const text = `a [unverified]\n${link}\nb [unverified]\n`
  assert.equal(deleteFact(text, 1, link), 'a [unverified]\nb [unverified]\n')
  assert.equal(deleteFact(text, 0, 'a [unverified]'), `${link}\nb [unverified]\n`)
  assert.throws(() => deleteFact(text, 0, 'zzz'), StaleEdit)
  assert.throws(() => deleteFact(text, 7, 'zzz'), StaleEdit)
})

test('a note citing a Python run is computed when the run is ok, unverified otherwise', () => {
  const py = labels(['003_a.py', '003_a.json', '004_b.py', '005_c.py'], { 3: 'ok', 4: 'error' })
  assert.equal(addFact('', 'mean is 4 [q 3]', py), 'mean is 4 [computed q 003]\n')
  assert.equal(addFact('', 'mean is 4 [q 4]', py), 'mean is 4 [unverified q 004]\n')
  assert.equal(addFact('', 'mean is 4 [q 5]', py), 'mean is 4 [unverified q 005]\n')
  assert.deepEqual(listFacts('x [computed q 003]\n'), [{ index: 0, line: 'x [computed q 003]', text: 'x', label: 'computed', query: 3 }])
  assert.equal(editFact('x [computed q 003]\n', 0, 'x [computed q 003]', 'y', py), 'y [computed q 003]\n')
  assert.equal(editFact('x [computed q 003]\n', 0, 'x [computed q 003]', 'y', labels(['003_a.py'])), 'y [unverified q 003]\n')
})

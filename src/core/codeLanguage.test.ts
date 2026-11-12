import assert from 'node:assert/strict'
import { test } from 'node:test'

import { firstMatch, languageOfPath, sqlToggleTitle } from './codeLanguage.ts'

test('a file gets its language from its extension, whatever the case', () => {
  assert.equal(languageOfPath('a/b/query.sql'), 'sql')
  assert.equal(languageOfPath('x.PY'), 'python')
  assert.equal(languageOfPath('notes.md'), 'markdown')
})

test('other files, and names without an extension, get none', () => {
  assert.equal(languageOfPath('data.csv'), undefined)
  assert.equal(languageOfPath('Makefile'), undefined)
  assert.equal(languageOfPath('x.constructor'), undefined)
  assert.equal(languageOfPath('x.toString'), undefined)
})

test('a search text is found case-insensitively, at its first match', () => {
  assert.deepEqual(firstMatch('Select a, SELECT b', 'select'), { anchor: 0, head: 6 })
  assert.deepEqual(firstMatch('abc DEF', 'def'), { anchor: 4, head: 7 })
})

test('no match, an empty search or none gives nothing', () => {
  assert.equal(firstMatch('abc', 'zzz'), undefined)
  assert.equal(firstMatch('abc', ''), undefined)
  assert.equal(firstMatch('abc', undefined), undefined)
})

test('only SQL has a toggle title, saying which text is shown', () => {
  assert.equal(sqlToggleTitle('sql', false), 'Formatted (o: original text)')
  assert.equal(sqlToggleTitle('sql', true), 'Original text (o: formatted)')
  assert.equal(sqlToggleTitle('python', false), undefined)
  assert.equal(sqlToggleTitle(undefined, true), undefined)
})

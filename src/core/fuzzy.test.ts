import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fuzzyRank } from './fuzzy.ts'

const id = (s: string) => s

test('an empty query returns the input unchanged', () => {
  const items = ['b', 'a']
  assert.deepEqual(fuzzyRank(items, '', id), ['b', 'a'])
  assert.deepEqual(fuzzyRank(items, '  ', id), ['b', 'a'])
})

test('only subsequence matches stay, ignoring case', () => {
  const found = fuzzyRank(['Alpha Beta', 'gamma', 'abc'], 'AB', id)
  assert.deepEqual([...found].sort(), ['Alpha Beta', 'abc'])
  assert.deepEqual(fuzzyRank(['gamma', 'delta'], 'xz', id), [])
  assert.deepEqual(fuzzyRank(['cba'], 'abc', id), [])
})

test('consecutive runs rank above scattered matches', () => {
  assert.deepEqual(fuzzyRank(['xaxbxcx', 'xabcx'], 'abc', id), ['xabcx', 'xaxbxcx'])
})

test('word-start matches rank above mid-word matches', () => {
  assert.deepEqual(fuzzyRank(['xxsurvey_rates', 'survey-rates-old'], 'sr', id), ['survey-rates-old', 'xxsurvey_rates'])
  assert.deepEqual(fuzzyRank(['xpanel', 'panel'], 'p', id), ['panel', 'xpanel'])
})

test('ties keep input order', () => {
  assert.deepEqual(fuzzyRank(['bb1', 'bb2', 'bb3'], 'bb', id), ['bb1', 'bb2', 'bb3'])
})

test('keyOf picks the text from an object', () => {
  const items = [{ n: 'one' }, { n: 'two' }]
  assert.deepEqual(fuzzyRank(items, 'tw', item => item.n), [{ n: 'two' }])
})

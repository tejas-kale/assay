import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EMPTY_SET } from './analysisSet.ts'
import { parseSavedSet } from './savedSet.ts'

test('a saved set comes back with its paths and current analysis', () => {
  assert.deepEqual(parseSavedSet('{"paths":["/a","/b"],"current":"/b"}'), { paths: ['/a', '/b'], current: '/b' })
})

test('non-string paths are dropped, duplicates merge, and a current outside the set falls back to the first', () => {
  assert.deepEqual(parseSavedSet('{"paths":["/a",3,"/a","/b"],"current":"/zzz"}'), { paths: ['/a', '/b'], current: '/a' })
  assert.deepEqual(parseSavedSet('{"paths":["/a"],"current":7}'), { paths: ['/a'], current: '/a' })
})

test('text that is not a saved set gives the empty set', () => {
  for (const text of ['', 'nope', 'null', '[]', '{}', '{"paths":"/a"}', '{"paths":[]}', '{"paths":[1]}']) assert.deepEqual(parseSavedSet(text), EMPTY_SET)
})

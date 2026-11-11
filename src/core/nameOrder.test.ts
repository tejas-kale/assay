import assert from 'node:assert/strict'
import { test } from 'node:test'

import { byCodeUnit, jsonFileNames } from './nameOrder.ts'

test('code units order upper case before lower case, unlike the locale', () => {
  assert.deepEqual(['b', 'B', 'a', 'A', '10', '9'].toSorted(byCodeUnit), ['10', '9', 'A', 'B', 'a', 'b'])
  assert.deepEqual(['é', 'z', 'Z'].toSorted(byCodeUnit), ['Z', 'z', 'é'])
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('a', 'b'), -1)
  assert.equal(byCodeUnit('b', 'a'), 1)
})

test('json file names skip temp files and other types', () => {
  assert.deepEqual(jsonFileNames(['001.json', '.002.json.tmp', '.003.json', 'a.txt', 'b.json.tmp', 'b.json']), ['001.json', 'b.json'])
  assert.deepEqual(jsonFileNames([]), [])
})

import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { byCodeUnit } from './codeUnitOrder.ts'

test('strings are ordered by code unit: capitals before lower case, as a default sort does', () => {
  expect(['b', 'B', 'a', 'é', 'Z'].toSorted(byCodeUnit)).toEqual(['B', 'Z', 'a', 'b', 'é'])
  expect(byCodeUnit('a', 'a')).toBe(0)
  expect(byCodeUnit('a', 'b')).toBe(-1)
  expect(byCodeUnit('b', 'a')).toBe(1)
})

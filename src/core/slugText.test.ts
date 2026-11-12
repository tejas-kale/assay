import assert from 'node:assert/strict'
import { test } from 'node:test'

import { kebabCase, trimEndChar } from './slugText.ts'

test('trimEndChar removes every trailing copy of the character and nothing else', () => {
  assert.equal(trimEndChar('a//', '/'), 'a')
  assert.equal(trimEndChar('///', '/'), '')
  assert.equal(trimEndChar('', '/'), '')
  assert.equal(trimEndChar('/a/b', '/'), '/a/b')
})

test('kebabCase joins runs of other characters with a dash, trims the ends, then cuts', () => {
  assert.equal(kebabCase('Hello, World!', 60), 'hello-world')
  assert.equal(kebabCase('-', 60), '')
  assert.equal(kebabCase('-a-', 60), 'a')
  assert.equal(kebabCase('ab cd', 3), 'ab')
  assert.equal(kebabCase('ab cd', 4), 'ab-c')
  assert.equal(kebabCase('ab cd', 5), 'ab-cd')
})

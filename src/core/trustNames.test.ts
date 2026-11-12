import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { allowedNames, isProposalFile } from './trustNames.ts'

test('a calculation may have its code, its tests and its rebuild; a dictionary entry its yaml and its tests', () => {
  expect(allowedNames('calculation', 'calc')).toEqual(['calc.sql', 'calc.py', 'test_calc.py', 'calc.test.yaml', 'calc.rebuild.sql'])
  expect(allowedNames('dictionary', 'a.b.c')).toEqual(['a.b.c.yaml', 'a.b.c.test.yaml'])
})

test('nothing else is a proposal file, and no name leaves its folder', () => {
  expect(isProposalFile('calculation', 'calc', 'calc.sql')).toBe(true)
  expect(isProposalFile('dictionary', 'a.b.c', 'a.b.c.yaml')).toBe(true)
  for (const bad of ['../x', '/etc/x', 'other.sql', 'sub/calc.sql', 'sub\\calc.sql', 'calc.sql\0', '..', '.', '', 'calc.yaml']) expect(isProposalFile('calculation', 'calc', bad)).toBe(false)
  expect(isProposalFile('calculation', 'calc', 'a.b.c.yaml')).toBe(false)
})

import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { approvalMessage, changedSince, hashesOf, parseApproveInput, parseProposalRef } from './trustApprove.ts'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

test('a proposal reference needs a valid name and a kind', () => {
  expect(parseProposalRef({ name: 'calc', kind: 'calculation' })).toEqual({ name: 'calc', kind: 'calculation' })
  for (const bad of [null, 'calc', [], { name: '../x', kind: 'calculation' }, { name: 'calc', kind: 'other' }, { name: 5, kind: 'dictionary' }]) expect(parseProposalRef(bad)).toEqual({ error: 'Invalid proposal' })
})

test('approving takes only the proposal\'s own file names with sha256 hashes', () => {
  expect(parseApproveInput({ name: 'calc', kind: 'calculation', hashes: { 'calc.sql': A, 'calc.test.yaml': B } })).toEqual({ name: 'calc', kind: 'calculation', hashes: { 'calc.sql': A, 'calc.test.yaml': B } })
  expect(parseApproveInput({ name: 'calc', kind: 'calculation', hashes: { '../x.sql': A } })).toEqual({ error: '"../x.sql" is not a file this proposal may have.' })
  expect(parseApproveInput({ name: 'calc', kind: 'calculation', hashes: { 'other.sql': A } })).toEqual({ error: '"other.sql" is not a file this proposal may have.' })
  for (const hashes of [undefined, [], {}, { 'calc.sql': 'xyz' }, { 'calc.sql': 5 }, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`n${String(i)}`, A]))]) expect(parseApproveInput({ name: 'calc', kind: 'calculation', hashes })).toEqual({ error: 'Invalid hashes' })
  expect(parseApproveInput({ name: 'x y', kind: 'calculation', hashes: {} })).toEqual({ error: 'Invalid proposal' })
})

test('the draft is as shown only when its files and every hash are the same', () => {
  const now = [{ name: 'calc.sql', sha256: A }]
  expect(changedSince({ 'calc.sql': A }, now)).toBeUndefined()
  expect(changedSince({ 'calc.sql': B }, now)).toMatch(/^The draft changed since you looked at it \(calc\.sql\)/)
  expect(changedSince({ 'calc.sql': A, 'calc.test.yaml': B }, now)).toMatch(/changed/)
  expect(changedSince({ 'calc.sql': A }, [...now, { name: 'calc.test.yaml', sha256: B }])).toMatch(/changed/)
  expect(changedSince({ 'calc.sql': A }, [])).toMatch(/no files now/)
  expect(changedSince({ 'constructor': A }, [{ name: 'calc.sql', sha256: A }])).toMatch(/changed/)
})

test('the approval line says trusted or already trusted, and that the copy is the server\'s', () => {
  const base = { name: 'calc', folder: 'trusted', outcome: 'approved' as const }
  expect(approvalMessage(base)).toBe("Trusted calc: approved in the app; Claude's side now copies it to trusted/.")
  expect(approvalMessage({ ...base, outcome: 'unchanged' })).toBe('Already trusted: no changes.')
})

test('Trust sends the hash of each file that was shown', () => {
  expect(hashesOf([{ name: 'calc.sql', text: 'x', sha256: A }, { name: 'calc.test.yaml', text: 'y', sha256: B }])).toEqual({ 'calc.sql': A, 'calc.test.yaml': B })
})

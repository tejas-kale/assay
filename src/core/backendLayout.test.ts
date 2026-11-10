import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { preparingLine, staleEntries } from './backendLayout.ts'

test('keeps this version and the one before it, and deletes the older ones', () => {
  expect(staleEntries(['0.4.1', '0.4.2', '0.4.3', '0.3.9'], '0.4.3')).toEqual(['0.4.1', '0.3.9'])
})

test('the version before is the highest one below this, by number not by text', () => {
  expect(staleEntries(['0.9.0', '0.10.0', '0.11.0', '0.10.1'], '0.11.0')).toEqual(['0.9.0', '0.10.0'])
})

test('a newer version (after a downgrade) is stale too; the dev folder is never touched', () => {
  expect(staleEntries(['0.5.0', '0.4.2', 'dev', '0.4.3'], '0.4.3')).toEqual(['0.5.0'])
})

test("a venv's status file goes with its version; a copy a crash left half done goes", () => {
  expect(staleEntries(['0.4.1', '0.4.1.status.json', '0.4.2.status.json', '0.4.3', '.tmp-0.4.3-k2j3'], '0.4.3')).toEqual(['0.4.1', '0.4.1.status.json', '.tmp-0.4.3-k2j3'])
})

test('the line the app shows while it prepares a version', () => {
  expect(preparingLine('0.4.3', 'backend')).toBe('Preparing Assay 0.4.3: copying the backend...')
  expect(preparingLine('0.4.3', 'venv')).toBe('Preparing Assay 0.4.3: Python environment...')
})

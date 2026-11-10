import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { mayStartVenvBuild, preparingNow } from './preparation.ts'

test('while the backend is copied, the app says so', () => {
  expect(preparingNow({ version: '0.4.3', isInstalling: true, venv: undefined })).toBe('Preparing Assay 0.4.3: copying the backend...')
})

test('while the venv builds, the app says so; once built or failed it says nothing', () => {
  expect(preparingNow({ version: '0.4.3', isInstalling: false, venv: { state: 'building' } })).toBe('Preparing Assay 0.4.3: Python environment...')
  expect(preparingNow({ version: '0.4.3', isInstalling: false, venv: { state: 'ready' } })).toBeUndefined()
  // A failure is the Doctor's to show, with its error.
  expect(preparingNow({ version: '0.4.3', isInstalling: false, venv: { state: 'failed', error: 'x' } })).toBeUndefined()
})

test('a venv build starts at launch, and again only after a failure', () => {
  expect(mayStartVenvBuild({ venv: undefined, isBuilding: false })).toBe(true)
  expect(mayStartVenvBuild({ venv: { state: 'failed', error: 'x' }, isBuilding: false })).toBe(true)
  expect(mayStartVenvBuild({ venv: { state: 'ready' }, isBuilding: false })).toBe(false)
})

test('never two builds at once, whatever the last state said', () => {
  expect(mayStartVenvBuild({ venv: undefined, isBuilding: true })).toBe(false)
  expect(mayStartVenvBuild({ venv: { state: 'failed', error: 'x' }, isBuilding: true })).toBe(false)
})

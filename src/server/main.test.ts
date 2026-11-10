import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { configFromEnv } from './main.ts'

const ENV = { ASSAY_ANALYSIS: '/notes/analyses/a', ASSAY_ROOT: '/notes', ASSAY_VENV: '/Users/me/Library/Application Support/Assay/venvs/0.4.3' }

test("the config takes Assay's venv from ASSAY_VENV", () => {
  expect(configFromEnv(ENV)?.venv).toBe(ENV.ASSAY_VENV)
})

test('without ASSAY_VENV, Assay did not start the session: there is no config', () => {
  expect(configFromEnv({ ...ENV, ASSAY_VENV: undefined })).toBeUndefined()
  expect(configFromEnv({ ...ENV, ASSAY_VENV: '' })).toBeUndefined()
})

test('a relative ASSAY_VENV is not one Assay set', () => {
  expect(configFromEnv({ ...ENV, ASSAY_VENV: 'venvs/0.4.3' })).toBeUndefined()
})

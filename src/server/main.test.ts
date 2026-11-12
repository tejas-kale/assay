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

test('the temporary folder is TMPDIR without its trailing slashes, or /tmp when that leaves nothing', () => {
  expect(configFromEnv({ ...ENV, TMPDIR: '/var/folders/x//' })?.tmp).toBe('/var/folders/x')
  expect(configFromEnv({ ...ENV, TMPDIR: '///' })?.tmp).toBe('/tmp')
})

test("the kernel runner is ASSAY_KERNEL_RUNNER when set, else the backend's python folder", () => {
  expect(configFromEnv({ ...ENV, ASSAY_KERNEL_RUNNER: '/opt/run.py' })?.runner).toBe('/opt/run.py')
  expect(configFromEnv(ENV)?.runner).toMatch(/python\/analysis_kernel\.py$/)
})

test('ASSAY_LEDGER is the ledger the server reads; a relative or missing one is ignored', () => {
  expect(configFromEnv({ ...ENV, ASSAY_LEDGER: '/data/trust-ledger/x.json' })?.ledger).toBe('/data/trust-ledger/x.json')
  expect(configFromEnv({ ...ENV, ASSAY_LEDGER: 'x.json' })?.ledger).toBeUndefined()
  expect(configFromEnv(ENV)?.ledger).toBeUndefined()
})

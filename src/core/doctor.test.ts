import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { blocksOpening, doctorChecks, parseProbes, probeScript } from './doctor.ts'
import type { Probes } from './doctor.ts'

const ALL: Probes = {
  claude: { path: '/opt/homebrew/bin/claude', version: '2.1.4 (Claude Code)' },
  node: { path: '/opt/homebrew/bin/node', version: 'v22.11.0' },
  uv: { path: '/opt/homebrew/bin/uv', version: 'uv 0.9.2 (Homebrew)' },
  databricks: { path: '/opt/homebrew/bin/databricks', version: 'Databricks CLI v0.250.0' },
  'rds-psql': { path: '/usr/local/bin/rds-psql', version: 'psql (PostgreSQL) 17.2' },
}
const check = (probes: Probes, name: string, venv: Parameters<typeof doctorChecks>[0]['venv'] = { state: 'ready' }) =>
  doctorChecks({ probes, venv }).find(c => c.name === name)

test('every tool found and the venv built: all ok, with their versions', () => {
  const checks = doctorChecks({ probes: ALL, venv: { state: 'ready' } })
  expect(checks.map(c => [c.name, c.status])).toEqual([
    ['claude', 'ok'],
    ['node', 'ok'],
    ['uv', 'ok'],
    ['databricks', 'ok'],
    ['rds-psql', 'ok'],
    ['Python environment', 'ok'],
  ])
  expect(checks[1]?.detail).toBe('v22.11.0 at /opt/homebrew/bin/node')
  expect(blocksOpening(checks)).toBe(false)
})

test('node 20 is too old, with its fix; node 22 is ok', () => {
  expect(check({ ...ALL, node: { path: '/usr/bin/node', version: 'v20.18.1' } }, 'node')).toEqual({
    name: 'node',
    status: 'too old',
    detail: 'v20.18.1 at /usr/bin/node; Assay needs 22 or later',
    fix: 'brew install node',
  })
  expect(check({ ...ALL, node: { path: '/usr/bin/node', version: 'v22.0.0' } }, 'node')?.status).toBe('ok')
})

test('a node that prints no version is too old: it cannot be shown to be 22', () => {
  expect(check({ ...ALL, node: { path: '/usr/bin/node', version: '' } }, 'node')?.status).toBe('too old')
})

test('a missing uv is missing, with its fix', () => {
  expect(check({ ...ALL, uv: {} }, 'uv')).toEqual({ name: 'uv', status: 'missing', detail: 'Not on the login shell\'s PATH', fix: 'brew install uv' })
})

test('a missing databricks gives the tap to install from', () => {
  expect(check({ ...ALL, databricks: {} }, 'databricks')?.fix).toBe('brew install databricks/tap/databricks')
})

test('rds-psql missing is optional: only a launcher brings it', () => {
  expect(check({ ...ALL, 'rds-psql': {} }, 'rds-psql')).toEqual({
    name: 'rds-psql',
    status: 'optional',
    detail: 'Not found: Postgres runs need a launcher that provides it',
    fix: 'See docs/process/launch-contract.md',
  })
})

test('only a missing claude blocks opening an analysis', () => {
  expect(blocksOpening(doctorChecks({ probes: { ...ALL, uv: {}, node: {}, databricks: {} }, venv: { state: 'failed', error: 'x' } }))).toBe(false)
  expect(blocksOpening(doctorChecks({ probes: { ...ALL, claude: {} }, venv: { state: 'ready' } }))).toBe(true)
})

test('the claude check is named for ASSAY_CLAUDE_BIN when it is set', () => {
  const checks = doctorChecks({ probes: { ...ALL, claude: {} }, venv: { state: 'ready' }, claudeBin: '/Users/me/bin/claude-podman' })
  expect(checks[0]).toEqual({ name: '/Users/me/bin/claude-podman', status: 'missing', detail: 'Not on the login shell\'s PATH', fix: 'Check ASSAY_CLAUDE_BIN' })
  expect(blocksOpening(checks)).toBe(true)
})

test('a failed venv build is reported with its error; a build in progress says so', () => {
  expect(check(ALL, 'Python environment', { state: 'failed', error: 'error: Failed to fetch numpy' })).toEqual({
    name: 'Python environment',
    status: 'failed',
    detail: 'error: Failed to fetch numpy',
    fix: 'Recheck builds it again',
  })
  expect(check(ALL, 'Python environment', { state: 'building' })).toEqual({ name: 'Python environment', status: 'building', detail: 'Building with uv' })
})

test('the probe script, run by sh, prints a line per tool that parseProbes reads back', () => {
  const script = probeScript()
  expect(script).toContain('command -v "${ASSAY_CLAUDE_BIN:-claude}"')
  const printed = [
    'claude\t/opt/homebrew/bin/claude\t2.1.4 (Claude Code)',
    'node\t/opt/homebrew/bin/node\tv22.11.0',
    'uv\t\t',
    'databricks\t/opt/homebrew/bin/databricks\tDatabricks CLI v0.250.0',
    'rds-psql\t\t',
    '',
  ].join('\n')
  expect(parseProbes(printed)).toEqual({ ...ALL, uv: {}, 'rds-psql': {} })
})

test('parseProbes counts a tool it never heard about as missing', () => {
  expect(parseProbes('node\t/usr/bin/node\tv22.1.0\n').uv).toEqual({})
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newCommand, openCommand } from './open.ts'

const facts = {
  root: '/work', analyses: ['sales', 'survey'], rootExists: true, backendReady: true, venvReady: true,
  userData: '/data', version: '1.2', env: { SHELL: '/bin/bash', ASSAY_CLAUDE_BIN: '/launcher' },
}

test('opening a known analysis uses the shared launch and configured launcher', () => {
  const result = openCommand({ ...facts, slug: 'sales' })
  assert.equal(result.kind, 'launch')
  assert.equal(result.spec.cwd, '/work')
  assert.equal(result.spec.env.ASSAY_ANALYSIS, '/work/analyses/sales')
  assert.equal(result.spec.env.ASSAY_CLAUDE_BIN, '/launcher')
  assert.equal(result.spec.env.ASSAY_BACKEND, '/data/backend/1.2')
  assert.equal(result.spec.env.ASSAY_VENV, '/data/venvs/1.2')
  assert.match(result.spec.env.ASSAY_LEDGER ?? '', /^\/data\/trust-ledger\/[a-f0-9]{64}\.json$/)
  assert.match(result.spec.args[1] ?? '', /ASSAY_CLAUDE_BIN:-claude/)
})

test('listing and failures name the problem before any launch', () => {
  assert.deepEqual(openCommand(facts), { kind: 'list', message: 'sales\nsurvey' })
  assert.deepEqual(openCommand({ ...facts, analyses: [] }), { kind: 'list', message: '(none)' })
  const invalid = [
    { input: { ...facts, root: undefined }, reason: /root is missing/ },
    { input: { ...facts, rootExists: false }, reason: /root is missing/ },
    { input: { ...facts, slug: '../sales' }, reason: /Unknown analysis/ },
    { input: { ...facts, slug: 'sales', backendReady: false }, reason: /backend is missing/ },
    { input: { ...facts, slug: 'sales', venvReady: false }, reason: /venv is not ready/ },
  ]
  for (const { input, reason } of invalid) {
    const result = openCommand(input)
    assert.equal(result.kind, 'error')
    assert.match(result.message, reason)
  }
  const unknown = openCommand({ ...facts, slug: 'missing' })
  if (unknown.kind === 'launch') throw new Error('Unexpected launch')
  assert.match(unknown.message, /Known analyses:\nsales\nsurvey/)
})

test('plain Claude and light themes retain the app launch contract', () => {
  const result = openCommand({ ...facts, slug: 'sales', env: { ASSAY_THEME: 'light-ansi' } })
  if (result.kind !== 'launch') throw new Error('Expected launch')
  assert.equal(result.spec.env.ASSAY_THEME, 'light-ansi')
  assert.equal(result.spec.env.ASSAY_CLAUDE_BIN, undefined)
  assert.equal(result.spec.file, '/bin/zsh')
})

test('new creates the analysis under the root and launches it with a notice', async () => {
  const made: string[] = []
  const result = await newCommand(facts, '  Panel   churn ', (root, title) => {
    made.push(`${root}|${title}`)
    return Promise.resolve('panel-churn')
  })
  assert.deepEqual(made, ['/work|Panel churn'])
  if (result.kind !== 'launch') throw new Error('Expected launch')
  assert.equal(result.notice, 'Created analyses/panel-churn')
  assert.equal(result.spec.env.ASSAY_ANALYSIS, '/work/analyses/panel-churn')
})

test('new refuses before creating anything when the title or launch is not possible', async () => {
  const invalid = [
    { input: facts, title: ' -- ', reason: /letters or digits/ },
    { input: { ...facts, root: undefined }, title: 'Sales', reason: /root is missing/ },
    { input: { ...facts, backendReady: false }, title: 'Sales', reason: /backend is missing/ },
    { input: { ...facts, venvReady: false }, title: 'Sales', reason: /venv is not ready/ },
  ]
  for (const { input, title, reason } of invalid) {
    const result = await newCommand(input, title, () => Promise.reject(new Error('created')))
    if (result.kind !== 'error') throw new Error('Expected error')
    assert.match(result.message, reason)
  }
})

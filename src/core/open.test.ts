import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newCommand, openCommand, pickAnswer } from './open.ts'

const facts = {
  root: '/work', analyses: [{ name: 'sales', title: 'Sales' }, { name: 'survey', title: 'Panel survey Q4' }], rootExists: true, backendReady: true, venvReady: true,
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

test('failures name the problem before any launch', () => {
  const invalid = [
    { input: { ...facts, root: undefined }, reason: /root is missing/ },
    { input: { ...facts, rootExists: false }, reason: /root is missing/ },
    { input: { ...facts, slug: 'sales', backendReady: false }, reason: /backend is missing/ },
    { input: { ...facts, slug: 'sales', venvReady: false }, reason: /venv is not ready/ },
  ]
  for (const { input, reason } of invalid) {
    const result = openCommand(input)
    assert.equal(result.kind, 'error')
    assert.match(result.message, reason)
  }
})

test('an analysis opens by its folder name, its title in any case, or the title typed as words', () => {
  // A folder name wins over a title, and a title over the typed words' slug.
  const analyses = [...facts.analyses, { name: 'panel-survey-q4', title: 'Panel survey Q4 (old)' }]
  const cases = [['survey', 'survey'], ['panel survey q4', 'survey'], ['Panel  Survey Q4', 'survey'], ['PANEL-SURVEY-Q4', 'panel-survey-q4'], ['Panel survey Q4 (old)', 'panel-survey-q4']]
  for (const [slug, folder] of cases) {
    const result = openCommand({ ...facts, slug, analyses })
    if (result.kind !== 'launch') throw new Error(`Expected a launch for ${String(slug)}`)
    assert.equal(result.spec.env.ASSAY_ANALYSIS, `/work/analyses/${String(folder)}`)
  }
})

test('no name, or one that matches nothing, offers a choice: narrowed by shared words, or all of them', () => {
  assert.deepEqual(openCommand(facts), { kind: 'choose', candidates: facts.analyses, message: 'sales\nsurvey' })
  assert.deepEqual(openCommand({ ...facts, analyses: [] }), { kind: 'choose', candidates: [], message: '(none)' })
  const narrowed = openCommand({ ...facts, slug: 'Q4 panel review' })
  assert.deepEqual(narrowed, {
    kind: 'choose', candidates: [facts.analyses[1]], failed: true,
    message: 'Unknown analysis: Q4 panel review\nKnown analyses:\nsales\nsurvey',
  })
  const unmatched = openCommand({ ...facts, slug: 'xyz' })
  if (unmatched.kind !== 'choose') throw new Error('Expected a choice')
  assert.deepEqual(unmatched.candidates, facts.analyses)
})

test('the answer to the choice is a number, a name, or nothing to cancel', () => {
  const { analyses } = facts
  assert.deepEqual(pickAnswer('2', analyses), { kind: 'open', slug: 'survey' })
  assert.deepEqual(pickAnswer(' panel survey q4 ', analyses), { kind: 'open', slug: 'survey' })
  assert.deepEqual(pickAnswer('', analyses), { kind: 'cancel' })
  for (const answer of ['0', '3', '1.5', 'nothing']) assert.deepEqual(pickAnswer(answer, analyses), { kind: 'again' })
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

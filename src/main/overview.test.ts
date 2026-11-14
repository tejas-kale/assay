import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadState } from './files.ts'
import { freezeOverviewPreface, markOverviewRead, overviewSignature, readOverview, resetOverviewPreface } from './overviewFiles.ts'

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'assay-overview-'))
  const path = join(root, 'analyses', 'a')
  await mkdir(join(path, 'queries'), { recursive: true })
  await writeFile(join(path, 'analysis.yaml'), 'title: A\n')
  return { root, path, analysis: { name: 'a', title: 'A', path } }
}

test('no overview.md: the state has no overview, or carries coverage when .assay/coverage.json exists', async () => {
  const { path, analysis } = await scratch()
  assert.deepEqual((await loadState(analysis)).overview, {})
  const before = await overviewSignature(path)
  await mkdir(join(path, '.assay'), { recursive: true })
  await writeFile(join(path, '.assay', 'coverage.json'), '{"trustedTokens":20,"totalTokens":32,"coverage":0.625}\n')
  assert.notEqual(await overviewSignature(path), before)
  assert.deepEqual((await loadState(analysis)).overview, {
    coverage: { trustedTokens: 20, totalTokens: 32, coverage: 0.625 },
  })
})

test('the state carries the analysis overview, the system it names and each baseline', async () => {
  const { root, path, analysis } = await scratch()
  await writeFile(join(path, 'overview.md'), '# A\nSystem: systems/buyer-rating.md\n\nNow.\n')
  assert.deepEqual(await readOverview(path), {
    analysis: { path: 'analyses/a/overview.md', text: '# A\nSystem: systems/buyer-rating.md\n\nNow.\n' },
    system: 'systems/buyer-rating.md',
  })
  await mkdir(join(root, 'systems'))
  await writeFile(join(root, 'systems', 'buyer-rating.md'), '# Buyer rating\n')
  await mkdir(join(path, '.assay', 'overview-read', 'systems'), { recursive: true })
  await writeFile(join(path, '.assay', 'overview-read', 'overview.md'), '# A\n\nBefore.\n')
  const state = (await loadState(analysis)).overview
  assert.equal(state.analysis?.baseline, '# A\n\nBefore.\n')
  assert.deepEqual(state.systemDoc, { path: 'systems/buyer-rating.md', text: '# Buyer rating\n' })
})

test('mark read copies the shown text to the baseline, and refuses a text that changed since', async () => {
  const { root, path } = await scratch()
  await writeFile(join(path, 'overview.md'), '# A\nSystem: systems/x.md\n')
  await mkdir(join(root, 'systems'))
  await writeFile(join(root, 'systems', 'x.md'), '# X\n')
  const before = await overviewSignature(path)
  assert.deepEqual(await markOverviewRead(path, 'analysis', '# A\nSystem: systems/x.md\n'), { ok: true })
  assert.equal(await readFile(join(path, '.assay', 'overview-read', 'overview.md'), 'utf8'), '# A\nSystem: systems/x.md\n')
  assert.notEqual(await overviewSignature(path), before)
  assert.deepEqual(await markOverviewRead(path, 'system', '# X\n'), { ok: true })
  assert.equal(await readFile(join(path, '.assay', 'overview-read', 'systems', 'x.md'), 'utf8'), '# X\n')
  assert.equal((await markOverviewRead(path, 'system', '# old\n')).ok, false)
  await writeFile(join(path, 'overview.md'), '# A\n')
  assert.deepEqual(await markOverviewRead(path, 'system', '# X\n'), { ok: false, reason: 'invalid', message: 'No such overview.' })
})

test('a run notices file is read safely', async () => {
  const { parseNotices } = await import('./runFiles.ts')
  assert.deepEqual(parseNotices('{"rules": ["a"], "retype": ["b", 3]}'), { rules: ['a'], retype: ['b'] })
  assert.equal(parseNotices(''), undefined)
  assert.equal(parseNotices('{bad'), undefined)
})

const VALID_DRAFT = JSON.stringify({
  low: 0.12,
  high: 0.18,
  known_total: 1250,
  tolerance: 5,
  falsifiers: ['The rollout matches the backtest.'],
  answer: 'rollout-rate',
  reconciliation: 'rollout-total',
  specs: [
    { id: 'rollout-rate', text: 'The spec you approved, in prose.' },
    { id: 'rollout-total', text: 'The reconciliation spec you approved, in prose.' },
  ],
})

test('freezeOverviewPreface and resetOverviewPreface freeze, archive, and refuse symlinked preface files or .assay folders', async () => {
  const { root, path } = await scratch()
  const outside = join(root, 'outside.json')
  await writeFile(outside, VALID_DRAFT)

  // Refuses a symlinked draft preface.json.
  await symlink(outside, join(path, 'preface.json'))
  const linkedDraft = await freezeOverviewPreface(path)
  assert.equal(linkedDraft.ok, false)
  await rm(join(path, 'preface.json'))

  // Refuses a symlinked .assay folder.
  await writeFile(join(path, 'preface.json'), VALID_DRAFT)
  await mkdir(join(root, 'fake-assay'))
  await symlink(join(root, 'fake-assay'), join(path, '.assay'))
  assert.equal((await freezeOverviewPreface(path)).ok, false)
  await rm(join(path, '.assay'))

  // Refuses a symlinked .assay/preface.json.
  await mkdir(join(path, '.assay'))
  await symlink(outside, join(path, '.assay', 'preface.json'))
  assert.equal((await freezeOverviewPreface(path)).ok, false)
  assert.equal((await resetOverviewPreface(path)).ok, false)
  assert.equal((await readOverview(path)).preface, undefined)
  await rm(join(path, '.assay', 'preface.json'))

  // Succeeds on real files and directories, then resets into .assay/preface-archive.
  assert.equal((await freezeOverviewPreface(path)).ok, true)
  const frozen = (await readOverview(path)).preface
  assert.ok(frozen?.id)
  assert.equal((await resetOverviewPreface(path)).ok, true)
  assert.equal((await readOverview(path)).preface, undefined)
})

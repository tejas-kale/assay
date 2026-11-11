import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadState } from './files.ts'
import { markOverviewRead, overviewSignature, readOverview } from './overviewFiles.ts'

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'assay-overview-'))
  const path = join(root, 'analyses', 'a')
  await mkdir(join(path, 'queries'), { recursive: true })
  await writeFile(join(path, 'analysis.yaml'), 'title: A\n')
  return { root, path, analysis: { name: 'a', title: 'A', path } }
}

test('no overview.md: the state has no overview', async () => {
  const { analysis } = await scratch()
  assert.deepEqual((await loadState(analysis)).overview, {})
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

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findOnPath, vdArgs, vdFiles, vdTarget } from './vd.ts'

const analyses = [
  { name: 'panel-churn', title: 'Panel churn' },
  { name: 'quarantine-checks', title: 'Quarantine Checks' },
]
const root = '/work/root'
const errorOf = (result: object) => ('error' in result ? String(result.error) : '')

test('a run number is all digits, and the other word names the analysis, in either order', () => {
  assert.deepEqual(vdArgs([]), {})
  assert.deepEqual(vdArgs(['12']), { run: 12 })
  assert.deepEqual(vdArgs(['churn']), { name: 'churn' })
  assert.deepEqual(vdArgs(['12', 'churn']), { run: 12, name: 'churn' })
  assert.deepEqual(vdArgs(['churn', '012']), { run: 12, name: 'churn' })
})

test('the analysis is the one named, else the one the terminal is in, else the most recently changed', () => {
  const facts = { cwd: '/elsewhere', root, analyses }
  assert.deepEqual(vdTarget([], facts), { analysis: 'panel-churn' })
  assert.deepEqual(vdTarget(['7', 'Quarantine checks'], facts), { analysis: 'quarantine-checks', run: 7 })
  for (const cwd of [`${root}/analyses/quarantine-checks`, `${root}/analyses/quarantine-checks/queries`]) {
    assert.deepEqual(vdTarget(['3'], { ...facts, cwd }), { analysis: 'quarantine-checks', run: 3 })
  }
  assert.deepEqual(vdTarget([], { ...facts, cwd: `${root}/analyses/quarantine-checks-old` }), { analysis: 'panel-churn' })
})

test('a missing root, an unknown name or no analyses at all is an error that says what to run', () => {
  assert.match(errorOf(vdTarget([], { cwd: '/', analyses })), /assay root/)
  assert.match(errorOf(vdTarget(['nope'], { cwd: '/', root, analyses })), /No analysis matches "nope"/)
  assert.match(errorOf(vdTarget([], { cwd: '/', root, analyses: [] })), /assay new/)
})

const names = ['001_counts.sql', '001_counts.csv', '002_plot.py', '002_plot.json', '002_plot.t2.csv', '002_plot.t1.csv', '003_broken.sql', 'notes.txt']

test('with no run, the newest run with a table opens; a Python run opens each table in K order', () => {
  assert.deepEqual(vdFiles(names), { run: 2, files: ['002_plot.t1.csv', '002_plot.t2.csv'] })
  assert.deepEqual(vdFiles(names, 1), { run: 1, files: ['001_counts.csv'] })
})

test('a run with no table, a run that does not exist and an empty queries folder say so', () => {
  assert.match(errorOf(vdFiles(names, 3)), /Run 3 has no table/)
  assert.match(errorOf(vdFiles(names, 9)), /No run 9 in this analysis\. The newest is 3\./)
  assert.equal(errorOf(vdFiles([], 9)), 'No run 9 in this analysis.')
  assert.match(errorOf(vdFiles(['003_broken.sql'])), /No run in this analysis has a table yet/)
})

test('vd is found in the first PATH folder that holds it', async () => {
  const has = (file: string) => Promise.resolve(file === '/b/vd' || file === '/c/vd')
  assert.equal(await findOnPath('vd', '/a::/b:/c', has), '/b/vd')
  assert.equal(await findOnPath('vd', '/a', has), undefined)
})

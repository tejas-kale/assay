import assert from 'node:assert/strict'
import { test } from 'node:test'

import { citationLabel, citationLabels } from './citationLabels.ts'
import type { LabelDeps } from './citationLabels.ts'

const Q = '/root/analyses/churn-q3/queries'

/** An in-memory port over file paths. */
function deps(files: Record<string, string>, currentCommit?: LabelDeps['currentCommit']): LabelDeps {
  return {
    root: '/root',
    fs: {
      readdir: path => {
        const prefix = `${path}/`
        const names = Object.keys(files).filter(each => each.startsWith(prefix)).map(each => each.slice(prefix.length).split('/')[0] ?? '')
        if (names.length === 0) return Promise.reject(new Error('ENOENT'))
        return Promise.resolve([...new Set(names)])
      },
      readFile: path => {
        const text = files[path]
        if (text === undefined) return Promise.reject(new Error('ENOENT'))
        return Promise.resolve(text)
      },
    },
    ...(currentCommit ? { currentCommit } : {}),
  }
}

const files = {
  [`${Q}/001_plain.sql`]: 'select 1',
  [`${Q}/001_plain.csv`]: 'a\n1\n',
  [`${Q}/002_nodata.sql`]: 'select 2',
  [`${Q}/003_calc.sql`]: '-- trusted: completes\n-- args: {}\n-- commit: abc123\nselect 3',
  [`${Q}/003_calc.csv`]: 'a\n1\n',
  [`${Q}/004_py.py`]: 'print(1)',
  [`${Q}/004_py.json`]: '{"status":"ok","stdout":""}',
  [`${Q}/005_bad.py`]: 'raise',
  [`${Q}/005_bad.json`]: '{"status":"error","stdout":""}',
  [`${Q}/006_nojson.py`]: 'x',
  [`${Q}/007_calc.sql`]: '-- trusted: completes\n-- args: {}\n-- commit: abc123\nselect 3',
}

test('label: a SQL run with a result is queried, without one unverified', async () => {
  const d = deps(files)
  assert.equal(await citationLabel(d, { analysis: 'churn-q3', number: 1 }), 'queried')
  assert.equal(await citationLabel(d, { analysis: 'churn-q3', number: 2 }), 'unverified')
})

test('label: a Python run is computed when it ended ok, else unverified', async () => {
  const d = deps(files)
  assert.equal(await citationLabel(d, { analysis: 'churn-q3', number: 4 }), 'computed')
  assert.equal(await citationLabel(d, { analysis: 'churn-q3', number: 5 }), 'unverified')
  assert.equal(await citationLabel(d, { analysis: 'churn-q3', number: 6 }), 'unverified')
})

test('label: a trusted run with a result is trusted; stale when the calculation has a newer commit', async () => {
  const cite = { analysis: 'churn-q3', number: 3 }
  assert.equal(await citationLabel(deps(files), cite), 'trusted')
  assert.equal(await citationLabel(deps(files, () => Promise.resolve('abc123')), cite), 'trusted')
  assert.equal(await citationLabel(deps(files, () => Promise.resolve('def456')), cite), 'stale')
  assert.equal(await citationLabel(deps(files, () => Promise.resolve(undefined)), cite), 'trusted')
  // No result, no trust.
  assert.equal(await citationLabel(deps(files, () => Promise.resolve('def456')), { analysis: 'churn-q3', number: 7 }), 'unverified')
})

test('label: an unknown analysis or run is missing', async () => {
  const d = deps(files)
  assert.equal(await citationLabel(d, { analysis: 'nope', number: 1 }), 'missing')
  assert.equal(await citationLabel(d, { analysis: 'churn-q3', number: 99 }), 'missing')
})

test('citationLabels labels each citation once, keyed by analysis and number', async () => {
  const labels = await citationLabels(deps(files), [
    { analysis: 'churn-q3', number: 1 },
    { analysis: 'churn-q3', number: 1 },
    { analysis: 'nope', number: 2 },
  ])
  assert.deepEqual([...labels], [
    ['churn-q3 q 1', 'queried'],
    ['nope q 2', 'missing'],
  ])
})

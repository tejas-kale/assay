import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkCoverage, checkRuff, parseCoverageJson, parseLcov, ruffCounts, withUnmeasured } from './ratchet.ts'

const full = { lines: 100, branches: 100 }

test('ruff: an untouched baseline passes and updates to itself', () => {
  const baseline = { 'python/a.py': { E501: 2 } }
  assert.deepEqual(checkRuff(baseline, { 'python/a.py': { E501: 2 } }), { failures: [], stale: [], updated: baseline })
})

test('ruff: a grown count fails, and the update never takes the growth', () => {
  const result = checkRuff({ 'python/a.py': { E501: 2 } }, { 'python/a.py': { E501: 3 } })
  assert.deepEqual(result.failures, ['python/a.py: E501 grew from 2 to 3'])
  assert.deepEqual(result.updated, { 'python/a.py': { E501: 2 } })
})

test('ruff: a new file or a new rule in a known file fails', () => {
  const result = checkRuff({ 'python/a.py': { E501: 1 } }, { 'python/a.py': { E501: 1, F401: 1 }, 'python/b.py': { E501: 1 } })
  assert.deepEqual(result.failures, ['python/a.py: F401 grew from 0 to 1', 'python/b.py: E501 grew from 0 to 1'])
  assert.deepEqual(result.updated, { 'python/a.py': { E501: 1 } })
})

test('ruff: a smaller count is stale until the update writes it; a count at zero leaves the baseline', () => {
  const result = checkRuff({ 'python/a.py': { E501: 3, F401: 1 }, 'python/gone.py': { N802: 1 } }, { 'python/a.py': { E501: 1 } })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.stale, ['python/a.py: E501 fell from 3 to 1', 'python/a.py: F401 fell from 1 to 0', 'python/gone.py: N802 fell from 1 to 0'])
  assert.deepEqual(result.updated, { 'python/a.py': { E501: 1 } })
})

test('ruff: counts come per file and rule, relative to the repo', () => {
  const report = [
    { filename: '/repo/python/a.py', code: 'E501' },
    { filename: '/repo/python/a.py', code: 'E501' },
    { filename: '/repo/python/tests/t.py', code: 'F401' },
  ]
  assert.deepEqual(ruffCounts(report, '/repo'), { 'python/a.py': { E501: 2 }, 'python/tests/t.py': { F401: 1 } })
})

test('coverage: a new file below 90% on lines or branches fails', () => {
  const result = checkCoverage({}, { 'src/core/new.ts': { lines: 95, branches: 80 }, 'src/core/ok.ts': { lines: 90, branches: 90 } })
  assert.deepEqual(result.failures, ['src/core/new.ts: branches 80% is below 90%'])
  assert.deepEqual(result.updated, {})
})

test('coverage: a file in the baseline may not drop below its figures', () => {
  const result = checkCoverage({ 'src/core/a.ts': { lines: 70, branches: 60 } }, { 'src/core/a.ts': { lines: 69.5, branches: 60 } })
  assert.deepEqual(result.failures, ['src/core/a.ts: lines fell from 70% to 69.5%'])
  assert.deepEqual(result.updated, { 'src/core/a.ts': { lines: 70, branches: 60 } })
})

test('coverage: an untouched baseline passes', () => {
  const baseline = { 'src/core/a.ts': { lines: 70, branches: 60 } }
  assert.deepEqual(checkCoverage(baseline, { 'src/core/a.ts': { lines: 70, branches: 60 } }), { failures: [], stale: [], updated: baseline })
})

test('coverage: a better figure is stale until the update writes it', () => {
  const result = checkCoverage({ 'src/core/a.ts': { lines: 70, branches: 60 } }, { 'src/core/a.ts': { lines: 75, branches: 60 } })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.stale, ['src/core/a.ts: lines rose from 70% to 75%'])
  assert.deepEqual(result.updated, { 'src/core/a.ts': { lines: 75, branches: 60 } })
})

test('coverage: a file reaching 90% on both leaves the baseline; so does a deleted file', () => {
  const result = checkCoverage({ 'src/core/a.ts': { lines: 70, branches: 60 }, 'src/core/gone.ts': { lines: 1, branches: 1 } }, { 'src/core/a.ts': full })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.stale, ['src/core/a.ts: reached 90%, leaves the baseline', 'src/core/gone.ts: no longer measured, leaves the baseline'])
  assert.deepEqual(result.updated, {})
})

test('coverage: one metric rising while the other falls fails, and the update keeps the better of each', () => {
  const result = checkCoverage({ 'src/core/a.ts': { lines: 70, branches: 60 } }, { 'src/core/a.ts': { lines: 80, branches: 50 } })
  assert.deepEqual(result.failures, ['src/core/a.ts: branches fell from 60% to 50%'])
  assert.deepEqual(result.updated, { 'src/core/a.ts': { lines: 80, branches: 60 } })
})

test('lcov: line and branch percentages per file, rounded down to 0.01; no branches counts as 100%', () => {
  const lcov = ['SF:src/core/a.ts', 'LF:3', 'LH:2', 'BRF:0', 'BRH:0', 'end_of_record', 'SF:src/core/b.ts', 'LF:4', 'LH:4', 'BRF:4', 'BRH:1', 'end_of_record'].join('\n')
  assert.deepEqual(parseLcov(lcov), { 'src/core/a.ts': { lines: 66.66, branches: 100 }, 'src/core/b.ts': { lines: 100, branches: 25 } })
})

test("coverage.py's JSON: per file, under the folder it ran in", () => {
  const report = { files: { 'analysis_db.py': { summary: { num_statements: 8, covered_lines: 6, num_branches: 0, covered_branches: 0 } } } }
  assert.deepEqual(parseCoverageJson(report, 'python'), { 'python/analysis_db.py': { lines: 75, branches: 100 } })
})

test('a file in scope that no test loads counts as 0%', () => {
  const measured = { 'src/core/a.ts': full }
  assert.deepEqual(withUnmeasured(measured, ['src/core/a.ts', 'src/hooks/io.ts']), { 'src/core/a.ts': full, 'src/hooks/io.ts': { lines: 0, branches: 0 } })
})

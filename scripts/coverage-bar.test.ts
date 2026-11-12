import assert from 'node:assert/strict'
import { test } from 'node:test'

import { belowBar, parseCoverageJson, parseLcov, withUnmeasured } from './coverage-bar.ts'

const full = { lines: 100, branches: 100 }

test('a file at 90% on both metrics meets the bar', () => {
  assert.deepEqual(belowBar({ 'src/core/a.ts': { lines: 90, branches: 90 }, 'python/b.py': full }), [])
})

test('each metric below 90% fails on its own, sorted by file', () => {
  const coverage = { 'src/core/b.ts': { lines: 89.99, branches: 95 }, 'src/core/a.ts': { lines: 50, branches: 0 } }
  assert.deepEqual(belowBar(coverage), [
    'src/core/a.ts: branches 0% is below 90%',
    'src/core/a.ts: lines 50% is below 90%',
    'src/core/b.ts: lines 89.99% is below 90%',
  ])
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

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { countSteps, moveStep, parseSteps, runningLabel, stepChecks, stepFiles, stepMark, stepMarks, stepNoticeLine, stepSlug, uncheckedLines } from './steps.ts'
import type { Step } from './steps.ts'

const join = { j: 1, source: 'order_lines', declared: '1:many' as const, keys: ['order_id'] }
const counts = (over: Record<string, string> = {}) => ({ assay_rows: '120', assay_grain_rows: '120', assay_j1_left_rows: '31', assay_j1_left_keys: '31', assay_j1_right_rows: '40', assay_j1_right_keys: '36', ...over })

test('grain passes when rows equal distinct grain tuples and fails with the number of duplicates', () => {
  const step = { grain: ['customer_id', 'order_date'] }
  assert.deepEqual(stepChecks(step, counts()), [{ kind: 'grain', ok: true, text: 'grain customer_id, order_date: 120 rows, 120 distinct' }])
  assert.deepEqual(stepChecks({ grain: ['customer_id'] }, counts({ assay_grain_rows: '117' })), [{ kind: 'grain', ok: false, text: 'grain customer_id has 3 duplicate rows' }])
  assert.equal(stepChecks({ grain: ['a'] }, counts({ assay_grain_rows: '119' }))[0]?.text, 'grain a has 1 duplicate row')
})

test('grain none expects exactly one row, and no grain line or no counts means no check', () => {
  assert.deepEqual(stepChecks({ grain: [] }, { assay_rows: '1' }), [{ kind: 'grain', ok: true, text: 'grain none (one row): 1 row' }])
  assert.deepEqual(stepChecks({ grain: [] }, { assay_rows: '7' }), [{ kind: 'grain', ok: false, text: 'grain none (one row) has 7 rows' }])
  assert.deepEqual(stepChecks({}, counts()), [])
  assert.deepEqual(stepChecks({ grain: ['a'] }, { assay_rows: '5' }), [])
  assert.deepEqual(stepChecks({ grain: ['a'] }, { assay_rows: 'x', assay_grain_rows: '5' }), [])
})

test('a join fails when a side declared 1 repeats its keys, naming the side and the counts', () => {
  const bad = stepChecks({ joins: [join] }, counts({ assay_j1_left_rows: '40', assay_j1_left_keys: '31' }))
  assert.deepEqual(bad, [{ kind: 'join', ok: false, text: 'join order_lines declared 1:many but the left side repeats order_id (40 rows, 31 keys)' }])
  const both = stepChecks({ joins: [{ ...join, declared: '1:1' as const }] }, counts({ assay_j1_left_rows: '40', assay_j1_left_keys: '31' }))
  assert.deepEqual(both.map(c => c.ok), [false, false])
  assert.match(both[1]?.text ?? '', /right side repeats/)
})

test('a join passes; a many side observed as 1 passes with the observed cardinality', () => {
  const ok = stepChecks({ joins: [join] }, counts())
  assert.deepEqual(ok, [{ kind: 'join', ok: true, text: 'join order_lines 1:many on order_id: left 31 rows, 31 keys; right 40 rows, 36 keys' }])
  const single = stepChecks({ joins: [join] }, counts({ assay_j1_right_rows: '31', assay_j1_right_keys: '31' }))
  assert.equal(single[0]?.ok, true)
  assert.match(single[0]?.text ?? '', /\(observed 1:1\)$/)
})

test('unchecked joins and joins with missing counts give no check; their reasons are dim lines', () => {
  const unchecked = { j: 2, source: 'x', declared: '1:1' as const, keys: ['k'], checked: false, reason: 'a CROSS JOIN has no keys' }
  assert.deepEqual(stepChecks({ joins: [unchecked] }, counts()), [])
  assert.deepEqual(stepChecks({ joins: [{ ...join, j: 9 }] }, counts()), [])
  assert.deepEqual(uncheckedLines({ joins: [join, unchecked] }), [{ kind: 'unchecked', ok: true, text: 'join x not checked: a CROSS JOIN has no keys' }])
})

const step = (over: Partial<Step>): Step => ({ k: 1, name: 'a', node: 2, status: 'ok', ...over })

test('a step is bad with a failed check or an error, ok once it ran, and as its status says otherwise', () => {
  assert.equal(stepMark(step({ status: 'ok', checks: [{ kind: 'grain', ok: true, text: '' }] })), 'ok')
  assert.equal(stepMark(step({ status: 'ok', checks: [{ kind: 'grain', ok: true, text: '' }, { kind: 'join', ok: false, text: '' }] })), 'bad')
  assert.equal(stepMark(step({ status: 'ok' })), 'ok')
  assert.equal(stepMark(step({ status: 'error' })), 'bad')
  assert.equal(stepMark(step({ status: 'running' })), 'running')
  assert.equal(stepMark(step({ status: 'skipped' })), 'skipped')
  assert.equal(stepMark(step({ status: 'pending' })), undefined)
  assert.deepEqual(stepMarks([step({ node: 3 }), step({ k: 2, node: 4, status: 'pending' }), step({ k: 3, node: 5, status: 'error' })]), { 3: 'ok', 5: 'bad' })
})

test('parseSteps reads a file and drops malformed steps, checks and joins', () => {
  const file = {
    run: 42,
    status: 'running',
    note: 'n',
    steps: [
      { k: 1, name: 'a', node: 2, status: 'ok', rows: 120, counts: { assay_rows: '120', bad: 5 }, grain: ['x', 4], checks: [{ kind: 'grain', ok: true, text: 't' }, { kind: 'grain', ok: 'yes', text: 't' }], joins: [{ j: 1, source: 's', declared: '1:many', keys: ['k'] }, { j: 2 }, { j: 3, source: 'u', declared: 'weird', checked: false, reason: 'r' }] },
      { k: 2, name: 'b', node: 3, status: 'sideways' },
      { k: 0, name: 'c', node: 3, status: 'ok' },
      7,
    ],
  }
  assert.deepEqual(parseSteps(JSON.stringify(file)), {
    run: 42,
    status: 'running',
    note: 'n',
    steps: [
      {
        k: 1,
        name: 'a',
        node: 2,
        status: 'ok',
        rows: 120,
        counts: { assay_rows: '120' },
        grain: ['x'],
        checks: [{ kind: 'grain', ok: true, text: 't' }],
        joins: [{ j: 1, source: 's', declared: '1:many', keys: ['k'] }, { j: 3, source: 'u', checked: false, reason: 'r' }],
      },
    ],
  })
  assert.equal(parseSteps('nope'), undefined)
  assert.equal(parseSteps('{"run":1,"status":"odd","steps":[]}'), undefined)
  assert.equal(parseSteps('{"run":1,"status":"done"}'), undefined)
})

test("stepFiles groups a run's step files by k and ignores runs and other numbers", () => {
  const names = ['042_spend.sql', '042_spend.csv', '042.lineage.json', '042.steps.json', '042.2_by_day.csv', '042.1_clean.sql', '042.1_clean.counts.sql', '042.1_clean.csv', '042.2_by_day.sql', '043.1_other.sql', '042.x_bad.sql']
  assert.deepEqual(stepFiles(names, 42), [
    { k: 1, name: 'clean', sql: '042.1_clean.sql', csv: '042.1_clean.csv', counts: '042.1_clean.counts.sql' },
    { k: 2, name: 'by_day', sql: '042.2_by_day.sql', csv: '042.2_by_day.csv' },
  ])
  assert.deepEqual(stepFiles(names, 7), [])
})

test('stepSlug keeps file names safe, moveStep clamps, runningLabel and stepNoticeLine read as the tab and Claude see them', () => {
  assert.equal(stepSlug('my cte/1'), 'my_cte_1')
  assert.equal(moveStep(1, -1, 4), 1)
  assert.equal(moveStep(4, 1, 4), 4)
  assert.equal(moveStep(2, 1, 4), 3)
  assert.equal(moveStep(1, 1, 0), 1)
  const file = { run: 1, status: 'running' as const, steps: [step({ status: 'ok' }), step({ k: 2, status: 'running' }), step({ k: 3, status: 'pending' })] }
  assert.equal(runningLabel(file), 'running step 2 of 3')
  assert.equal(runningLabel({ ...file, steps: [step({})] }), undefined)
  assert.equal(runningLabel(undefined), undefined)
  assert.equal(stepNoticeLine(42, { name: 'spend_per_customer' }, { text: 'grain customer_id has 3 duplicate rows' }), 'q042 step spend_per_customer: grain customer_id has 3 duplicate rows.')
})

test('countSteps counts the plan when there is one and the step csv files otherwise', () => {
  const names = ['042.1_a.csv', '042.2_b.csv', '042.2_b.sql', '042.3_c.sql', '043.1_a.csv']
  assert.equal(countSteps(names, 42), 2)
  assert.equal(countSteps(names, 42, { run: 42, status: 'running', steps: [step({}), step({ k: 2 }), step({ k: 3 }), step({ k: 4 })] }), 4)
  assert.equal(countSteps(names, 42, { run: 42, status: 'done', steps: [] }), 0)
  assert.equal(countSteps([], 1), 0)
})

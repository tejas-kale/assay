import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { buildDefenceSheet, extractDateWindows, parseDecisions, parseNotices, renderDefenceSheet } from './defenceSheet.ts'
import type { DefenceRunInput } from './defenceSheet.ts'
import type { FrozenPreface } from './preface.ts'

const rolloutPreface: FrozenPreface = {
  id: 'pref12345678',
  frozenAt: '2026-11-14T10:00:00.000Z',
  low: 0.12,
  high: 0.18,
  known_total: 1250,
  tolerance: 5,
  falsifiers: [
    'The rollout completion rate matches the backtest within the expected range.',
    'Holdout window 2026-10-01 to 2026-10-14 shows no drop in buyer conversion.',
  ],
  answer: 'rollout-rate',
  reconciliation: 'rollout-total',
  specs: [
    {
      id: 'rollout-rate',
      text: 'Completion rate across eligible sessions between 2026-11-01 and 2026-11-08.',
    },
    {
      id: 'rollout-total',
      text: 'Total eligible sessions between 2026-11-01 and 2026-11-08.',
    },
  ],
}

const passingRuns: readonly DefenceRunInput[] = [
  {
    number: 1,
    slug: 'explore-sessions',
    code: 'SELECT count(*) AS n FROM cint.mkt.sessions\n',
    csv: 'n\n5000\n',
  },
  {
    number: 2,
    slug: 'rollout-rate-first',
    code: [
      '-- preface: pref12345678',
      '-- spec: rollout-rate',
      '-- built from: client_entry_sessions@1a2b3c',
      "SELECT 0.09 AS completion_rate WHERE day BETWEEN '2026-11-01' AND '2026-11-08'",
    ].join('\n'),
    csv: 'completion_rate\n0.09\n',
  },
  {
    number: 3,
    slug: 'rollout-rate-fixed',
    code: [
      '-- preface: pref12345678',
      '-- spec: rollout-rate',
      '-- built from: client_entry_sessions@1a2b3c, cint.mkt.sessions:completed@9f8e7d',
      "SELECT 'all' AS cohort, 0.15 AS completion_rate WHERE day BETWEEN '2026-11-01' AND '2026-11-08'",
    ].join('\n'),
    csv: 'cohort,completion_rate\nall,0.15\n',
    steps: {
      run: 3,
      status: 'done',
      steps: [
        { k: 1, name: 'sessions', node: 0, status: 'ok', rows: 1248, block: 'client_entry_sessions' },
        { k: 2, name: 'final', node: 1, status: 'ok', rows: 1 },
      ],
    },
  },
  {
    number: 4,
    slug: 'rollout-total',
    code: [
      '-- preface: pref12345678',
      '-- spec: rollout-total',
      '-- built from: client_entry_sessions@1a2b3c',
      "SELECT 1248 AS total_sessions WHERE day BETWEEN '2026-11-01' AND '2026-11-08'",
    ].join('\n'),
    csv: 'total_sessions\n1248\n',
    steps: {
      run: 4,
      status: 'done',
      steps: [{ k: 1, name: 'final', node: 0, status: 'ok', rows: 1 }],
    },
  },
]

test('compares latest answer run to [low, high] and latest reconciliation run to known_total ± tolerance, while listing earlier runs', () => {
  const sheet = buildDefenceSheet({
    preface: rolloutPreface,
    coverage: { trustedTokens: 42, totalTokens: 60, coverage: 0.7 },
    runs: passingRuns,
  })

  expect(sheet.flags.anyFlagged).toBe(false)
  expect(sheet.answer.latestRun?.number).toBe(3)
  expect(sheet.answer.actual).toBe(0.15)
  expect(sheet.answer.inRange).toBe(true)
  expect(sheet.answer.earlierRuns.map(r => r.number)).toEqual([2])
  expect(sheet.reconciliation.status).toBe('passed')
  expect(sheet.reconciliation.latestRun?.number).toBe(4)
  expect(sheet.reconciliation.actual).toBe(1248)
  expect(sheet.reconciliation.diff).toBe(2)

  const markdown = renderDefenceSheet(sheet)
  expect(markdown).toContain('pref12345678')
  expect(markdown).toContain('[q 003]')
  expect(markdown).toContain('[q 002]')
  expect(markdown).toContain('1250 ± 5')
  expect(markdown).toContain('70% (42 / 60 tokens)')
  expect(markdown).toContain('client_entry_sessions@1a2b3c')
  expect(markdown).toContain('2026-11-01, 2026-11-08')
  expect(markdown).toContain('sessions (block client_entry_sessions): 1248 rows')
  expect(markdown).toContain('Holdout window 2026-10-01 to 2026-10-14 shows no drop in buyer conversion.')
})

test('parses notices and decision logs safely', () => {
  const notices = parseNotices('{"rules":["warn 1"],"retype":["cint.mkt.sessions:completed written by hand"]}\n')
  expect(notices).toEqual({
    rules: ['warn 1'],
    retype: ['cint.mkt.sessions:completed written by hand'],
  })
  expect(parseNotices('invalid-json')).toEqual({ rules: [], retype: [] })
  expect(parseNotices('null')).toEqual({ rules: [], retype: [] })

  const decisions = parseDecisions(
    [
      '# Decisions',
      '- **Duplicate session ids**: keep earliest timestamp — retries within 5s are network duplicates ([q 005])',
      '* **Null device type**: bucket under unknown -- 0.2% of traffic',
      '- malformed bullet without bold colon',
      '- **Missing separator**: only one part',
    ].join('\n'),
  )
  expect(decisions).toEqual([
    {
      decision: 'Duplicate session ids',
      defaultTaken: 'keep earliest timestamp',
      why: 'retries within 5s are network duplicates',
      run: 5,
    },
    {
      decision: 'Null device type',
      defaultTaken: 'bucket under unknown',
      why: '0.2% of traffic',
    },
  ])
})

const flaggedRuns: readonly DefenceRunInput[] = [
  {
    number: 1,
    slug: 'old-preface-run',
    code: '-- preface: olderpref000\n-- spec: rollout-rate\nSELECT 0.15 AS completion_rate\n',
    csv: 'completion_rate\n0.15\n',
  },
  {
    number: 5,
    slug: 'rollout-rate-miss',
    code: '-- preface: pref12345678\n-- spec: rollout-rate\nSELECT 0.25 AS completion_rate\n',
    csv: 'completion_rate\n0.25\n',
    notices: { rules: [], retype: ['cint.mkt.sessions:completed written by hand'] },
    steps: {
      run: 5,
      status: 'done',
      steps: [
        {
          k: 1,
          name: 'deduped',
          node: 0,
          status: 'ok',
          checks: [{ kind: 'grain', ok: false, text: 'grain session_id has 3 duplicate rows' }],
        },
      ],
    },
  },
  {
    number: 6,
    slug: 'rollout-total-miss',
    code: '-- preface: pref12345678\n-- spec: rollout-total\nSELECT 1100 AS total_sessions\n',
    csv: 'total_sessions\n1100\n',
  },
  {
    number: 7,
    slug: 'unfrozen-extra',
    code: '-- preface: pref12345678\n-- spec: extra-breakdown (unfrozen)\nSELECT 1 AS n\n',
    csv: 'n\n\n',
  },
]

test('surfaces all four review flags and ignores runs from another preface', () => {
  const sheet = buildDefenceSheet({
    preface: rolloutPreface,
    runs: flaggedRuns,
    decisions: [
      {
        decision: 'Duplicate session ids',
        defaultTaken: 'keep earliest timestamp',
        why: 'retries within 5s are network duplicates',
        run: 5,
      },
    ],
  })

  expect(sheet.flags).toEqual({
    range: true,
    reconciliation: true,
    retype: true,
    decisions: true,
    anyFlagged: true,
  })
  expect(sheet.retypeWarnings).toEqual([
    'q005: cint.mkt.sessions:completed written by hand',
    'q007: spec "extra-breakdown" was not frozen in .assay/preface.json',
  ])

  const md = renderDefenceSheet(sheet)
  expect(md).toContain('SQL review required: one or more flags triggered.')
  expect(md).toContain('Range (FLAG)')
  expect(md).toContain('Reconciliation (FLAG)')
  expect(md).toContain('Retype & Unfrozen Spec Warnings (FLAG)')
  expect(md).toContain('Logged Decisions (FLAG)')
  expect(md).toContain('Spec `extra-breakdown` (UNFROZEN)')
  expect(md).toContain('deduped: ok — FAILED: grain session_id has 3 duplicate rows')
  expect(md).toContain('**Duplicate session ids**: keep earliest timestamp — retries within 5s are network duplicates ([q 005])')
  expect(md).toContain('no SQL tokens recorded')
})

test('handles optimisation preface without known_total, missing runs, and extractDateWindows', () => {
  const optPreface: FrozenPreface = {
    id: 'opt987654321',
    frozenAt: '2026-11-14T12:00:00.000Z',
    low: 0.02,
    high: 0.08,
    tolerance: 0,
    falsifiers: ['Holdout 2026-10-15..2026-10-31 does not regress.'],
    answer: 'opt-lift',
    reconciliation: 'opt-check',
    specs: [
      { id: 'opt-lift', text: 'Lift on tuning window.' },
      { id: 'opt-check', text: 'Holdout window check.' },
    ],
  }

  const missingSheet = buildDefenceSheet({ preface: optPreface, runs: [] })
  expect(missingSheet.flags.range).toBe(true)
  expect(missingSheet.flags.reconciliation).toBe(false)
  expect(missingSheet.reconciliation.status).toBe('omitted')
  expect(renderDefenceSheet(missingSheet)).toContain('known_total omitted (optimisation task)')

  expect(extractDateWindows("start => '2026-11-01', end => '2026-11-08', repeat '2026-11-01'")).toEqual([
    '2026-11-01',
    '2026-11-08',
  ])
})

test('plugin/skills/delegate/SKILL.md defines the delegate workflow skill and handoff rules', async () => {
  const skill = await readFile(join(process.cwd(), 'plugin/skills/delegate/SKILL.md'), 'utf8')
  expect(skill).toContain('name: delegate')
  expect(skill).toContain('preface.json')
  expect(skill).toContain('.assay/preface.json')
  expect(skill).toContain('.assay/coverage.json')
  expect(skill).toContain('defence-sheet.md')
  expect(skill).toContain('decisions.md')
})

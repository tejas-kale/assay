// The analysis mod's trust-model tests (config b2f7df2, claude/analysis/tests/trust-model.test.ts), ported.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { checkArgs, dictionaryText, draftHint, isGuarded, newSeen, parseTrustedHeader, runHeader, signature, splitCheckEvents } from './calculations.ts'
import type { Param } from './calculations.ts'
import { calculationRules, trustRules } from './rules.ts'
import { parseRunHeader } from './runs.ts'

const PARAMS: Param[] = [
  { name: 'start', type: 'date', required: true },
  { name: 'n', type: 'integer', required: false },
  { name: 'rate', type: 'number', required: false },
  { name: 'flag', type: 'boolean', required: false },
]

test('arguments are checked against the declared types', async () => {
  expect(checkArgs(PARAMS, { start: '2026-01-02', n: 3, rate: 0.5, flag: true })).toEqual({ args: { start: '2026-01-02', n: 3, rate: 0.5, flag: true } })
  expect(checkArgs([], undefined)).toEqual({ args: {} })
  expect(checkArgs(PARAMS, {})).toEqual({ error: 'Missing argument: start (date).' })
  expect(checkArgs(PARAMS, { start: '2026-13-45' })).toEqual({ error: 'Argument start must be a date as YYYY-MM-DD.' })
  expect(checkArgs(PARAMS, { start: '2026-01-02', n: 1.5 })).toEqual({ error: 'Argument n must be a integer.' })
  expect(checkArgs(PARAMS, { start: '2026-01-02', flag: 'yes' })).toEqual({ error: 'Argument flag must be a boolean.' })
  expect(checkArgs(PARAMS, ['2026-01-02'])).toEqual({ error: 'Give args as an object of named arguments.' })
  expect(signature({ name: 'f', parameters: PARAMS })).toBe('f(start: date, n?: integer, rate?: number, flag?: boolean)')
})

test("a trusted run's header round-trips, and the app reads its name from it", async () => {
  const header = { name: 'f', args: { start: '2026-01-02' }, commit: 'abc' }
  expect(parseTrustedHeader(`${runHeader(header)}\nSELECT 1\n`)).toEqual(header)
  expect(parseTrustedHeader('SELECT 1\n')).toBeUndefined()
  expect(parseRunHeader(`${runHeader(header)}\nSELECT 1\n`).trusted).toBe('f')
})

test('only paths inside dictionaries/ and trusted/ of the shared folder are guarded', async () => {
  const home = '/c/notes-src'
  expect(isGuarded('/c/notes-src/trusted/x.sql', home, '/')).toBe(true)
  expect(isGuarded('../../dictionaries/a.yaml', home, '/c/notes-src/analyses/a')).toBe(true)
  expect(isGuarded('/c/notes-src/trusted-old/x', home, '/')).toBe(false)
  expect(isGuarded('/c/notes-src/analyses/a/lib/trusted/x.sql', home, '/')).toBe(false)
})

test('dictionary text names each table and term once per session', async () => {
  const seen = newSeen()
  const answer = { tables: [{ name: 's', entry: 'm.p.s', text: 'description: S.\n', terms: ['q'] }, { name: 'm.p.t' }], glossary: { q: 'Q.' } }
  expect(dictionaryText(answer, seen)?.split('\n').slice(0, 5)).toEqual(['Data dictionary (first use this session):', '## m.p.s', 'description: S.', 'Glossary:', '- q: Q.'])
  expect(dictionaryText(answer, seen)).toBeUndefined()
})

test('streamed check lines split into events; partial and stray lines are left or dropped', () => {
  const step = { step: 'test', ok: false, text: 'FAILED', name: 'case 1', diff: '- a\n+ b' }
  const text = [
    JSON.stringify({ event: 'start', name: 'x', kind: 'sql' }),
    'a stray print',
    JSON.stringify({ event: 'step', step }),
    JSON.stringify({ event: 'step', step: { nope: 1 } }),
    JSON.stringify({ event: 'done', answer: { error: 'boom' } }),
    '{"event": "ste',
  ].join('\n')
  const { events, rest } = splitCheckEvents(text)
  expect(events).toEqual([
    { event: 'start', name: 'x', kind: 'sql' },
    { event: 'step', step },
    { event: 'done', answer: { error: 'boom' } },
  ])
  expect(rest).toBe('{"event": "ste')
})

test('every pointer to approval names the Trust tab, never /an trust', () => {
  const texts = [trustRules('/c/notes-src'), calculationRules(undefined), draftHint('m.p.t')]
  for (const text of texts) {
    expect(text).toContain('the Trust tab in Assay')
    expect(text).not.toContain('/an')
  }
})

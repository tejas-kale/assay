// The analysis mod's trust-model tests (config b2f7df2, claude/analysis/tests/trust-model.test.ts), ported.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { blockSignature, checkArgs, dictionaryText, draftHint, isGuarded, newSeen, normalPath, otherAnalysis, parseTrustedHeader, runHeader, signature, splitCheckEvents } from './calculations.ts'
import type { Param } from './calculations.ts'
import { calculationData, calculationRules } from './rules.ts'
import { parseRunHeader } from './runs.ts'

const PARAMS: Param[] = [
  { name: 'start', type: 'date', required: true },
  { name: 'n', type: 'integer', required: false },
  { name: 'rate', type: 'number', required: false },
  { name: 'flag', type: 'boolean', required: false },
]

test('arguments are checked against the declared types', () => {
  expect(checkArgs(PARAMS, { start: '2026-01-02', n: 3, rate: 0.5, flag: true })).toEqual({ args: { start: '2026-01-02', n: 3, rate: 0.5, flag: true } })
  expect(checkArgs([], undefined)).toEqual({ args: {} })
  expect(checkArgs(PARAMS, {})).toEqual({ error: 'Missing argument: start (date).' })
  expect(checkArgs(PARAMS, { start: '2026-13-45' })).toEqual({ error: 'Argument start must be a date as YYYY-MM-DD.' })
  expect(checkArgs(PARAMS, { start: '2026-01-02', n: 1.5 })).toEqual({ error: 'Argument n must be a integer.' })
  expect(checkArgs(PARAMS, { start: '2026-01-02', flag: 'yes' })).toEqual({ error: 'Argument flag must be a boolean.' })
  expect(checkArgs(PARAMS, ['2026-01-02'])).toEqual({ error: 'Give args as an object of named arguments.' })
  expect(signature({ name: 'f', parameters: PARAMS })).toBe('f(start: date, n?: integer, rate?: number, flag?: boolean)')
})

test("a trusted run's header round-trips, and the app reads its name from it", () => {
  const header = { name: 'f', args: { start: '2026-01-02' }, commit: 'abc' }
  expect(parseTrustedHeader(`${runHeader(header)}\nSELECT 1\n`)).toEqual(header)
  expect(parseTrustedHeader('SELECT 1\n')).toBeUndefined()
  // Only the leading comment lines are the header: a trusted line further down is the query's own text (audit PI-3).
  expect(parseTrustedHeader(`-- author: claude\nSELECT 1\n${runHeader(header)}\n`)).toBeUndefined()
  expect(parseRunHeader(`${runHeader(header)}\nSELECT 1\n`).trusted).toBe('f')
})

test('only paths inside dictionaries/ and trusted/ of the shared folder are guarded', () => {
  const home = '/c/notes-src'
  expect(isGuarded('/c/notes-src/trusted/x.sql', home, '/')).toBe(true)
  expect(isGuarded('../../dictionaries/a.yaml', home, '/c/notes-src/analyses/a')).toBe(true)
  expect(isGuarded('/c/notes-src/trusted-old/x', home, '/')).toBe(false)
  expect(isGuarded('/c/notes-src/analyses/a/lib/trusted/x.sql', home, '/')).toBe(false)
})

test('dictionary text names each table and term once per session', () => {
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
  const texts = [calculationRules(undefined)]
  for (const text of texts) {
    expect(text).toContain('the Trust tab in Assay')
    expect(text).not.toContain('/an')
  }
})

test('blocks are listed apart, with their contract', () => {
  const block = { name: 'entry_sessions', kind: 'sql' as const, file: 'entry_sessions.sql', description: 'Entry sessions.', parameters: [{ name: 'start', type: 'date' as const, required: true }], commit: 'abc', dirty: false, block: { grain: ['session_id'], columns: ['session_id', 'buyer'] } }
  const calc = { ...block, name: 'completes', description: 'Completes.', block: undefined }
  const list = { calculations: [block, { ...calc }], problems: [] }
  expect(calculationRules(list)).toContain('include blocks and definitions by name')
  expect(calculationData(list)).toEqual([
    { label: 'trusted blocks (params -> grain: columns)', lines: ['- entry_sessions(start: date) -> grain session_id: session_id, buyer: Entry sessions.'] },
    { label: 'dictionary definitions (<table>:<name>)', lines: [] },
    { label: 'trusted calculations', lines: ['- completes(start: date): Completes.'] },
  ])
})

test('a missing entry is hinted by what the name can say: a full name drafts, a short one asks for its catalog', () => {
  expect(draftHint('m.p.t')).toBe("No data dictionary entry for m.p.t. Draft it with the assay:propose-trusted skill and the table's full name: m.p.t.")
  expect(draftHint('t')).toBe('No data dictionary entry for t. To draft one, find its catalog and schema: its entry is named catalog.schema.table.')
})

test('dictionary text gives each missing table its hint, each term its glossary line, and nothing for what was seen', () => {
  const seen = newSeen()
  const answer = {
    tables: [{ name: 'a', entry: 'm.p.a', text: 'A\n', terms: ['x', 'y'] }, { name: 'b', entry: 'm.p.b', text: 'B', terms: ['x'] }, { name: 'c', entry: 'm.p.c' }, { name: 'd' }],
    glossary: { x: 'X.' },
  }
  const text = dictionaryText(answer, seen)?.split('\n')
  expect(text).toEqual([
    'Data dictionary (first use this session):',
    '## m.p.a\nA',
    '## m.p.b\nB',
    'Glossary:',
    '- x: X.',
    '- y: ',
    draftHint('c'),
    draftHint('d'),
  ].flatMap(line => line.split('\n')))
  expect(seen.terms).toEqual(new Set(['x', 'y']))
  expect(dictionaryText({ tables: [], glossary: {} }, newSeen())).toBeUndefined()
})

test('every parameter type has its check and its name in the message', () => {
  const params: Param[] = [
    { name: 's', type: 'string', required: false },
    { name: 'l', type: 'list', required: false },
    { name: 'r', type: 'number', required: false },
  ]
  expect(checkArgs(params, { s: 'a', l: ['a', 'b'], r: 2 })).toEqual({ args: { s: 'a', l: ['a', 'b'], r: 2 } })
  expect(checkArgs(params, { s: 1 })).toEqual({ error: 'Argument s must be a string.' })
  expect(checkArgs(params, { l: ['a', 1] })).toEqual({ error: 'Argument l must be a list of names.' })
  expect(checkArgs(params, { l: 'a' })).toEqual({ error: 'Argument l must be a list of names.' })
  expect(checkArgs(params, { r: Infinity })).toEqual({ error: 'Argument r must be a number.' })
  expect(checkArgs(params, { r: '2' })).toEqual({ error: 'Argument r must be a number.' })
  expect(checkArgs(params, { z: 1 })).toEqual({ error: 'Unknown arguments: z. It takes s, l, r.' })
  expect(checkArgs([], { z: 1 })).toEqual({ error: 'Unknown arguments: z. It takes none.' })
  expect(checkArgs(params, null)).toEqual({ error: 'Give args as an object of named arguments.' })
  expect(checkArgs(params, 'x')).toEqual({ error: 'Give args as an object of named arguments.' })
})

test('a parameter of a type the list does not know is read as a date', () => {
  const odd = [{ name: 'w', type: 'weird', required: false }] as unknown as Param[]
  expect(checkArgs(odd, { w: '2026-01-02' })).toEqual({ args: { w: '2026-01-02' } })
  expect(checkArgs(odd, { w: 'x' })).toEqual({ error: 'Argument w must be a weird.' })
})

test('a block is named with its grain and columns', () => {
  const calc = { name: 'b', parameters: PARAMS.slice(0, 1), block: { grain: ['id', 'day'], columns: ['id', 'day', 'n'] } }
  expect(blockSignature(calc)).toBe('b(start: date) -> grain id, day: id, day, n')
  expect(blockSignature({ ...calc, block: { grain: [], columns: ['n'] } })).toBe('b(start: date) -> grain one row: n')
})

test('paths are resolved against the base, and another analysis is named by its folder', () => {
  expect(normalPath('../x/./y', '/a/b')).toBe('/a/x/y')
  expect(normalPath('/a//b/../c', '/z')).toBe('/a/c')
  expect(normalPath('../../..', '/a')).toBe('/')
  const home = '/c/root'
  expect(otherAnalysis('/c/root/analyses/other/q.sql', home, '/c/root/analyses/mine', '/')).toBe('analyses/other')
  expect(otherAnalysis('/c/root/analyses/MINE/q.sql', home, '/c/root/analyses/mine', '/')).toBeUndefined()
  expect(otherAnalysis('/c/root/notes/x.md', home, '/c/root/analyses/mine', '/')).toBeUndefined()
  expect(otherAnalysis('../other/q.sql', home, '/c/root/analyses/mine', '/c/root/analyses/mine')).toBe('analyses/other')
})

test('an unreadable or non-object args line still names the trusted calculation', () => {
  expect(parseTrustedHeader('-- trusted: f\n-- args: {oops\n')).toEqual({ name: 'f', args: {}, commit: '' })
  expect(parseTrustedHeader('-- trusted: f\n-- args: null\n-- commit: abc\n')).toEqual({ name: 'f', args: {}, commit: 'abc' })
  expect(parseTrustedHeader('-- trusted: f\n')).toEqual({ name: 'f', args: {}, commit: '' })
})

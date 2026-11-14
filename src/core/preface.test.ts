import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import {
  FROZEN_PREFACE_FILE,
  PREFACE_ARCHIVE_DIR,
  PREFACE_DRAFT_FILE,
  freezePreface,
  parseFrozenPreface,
  parsePreface,
  readFrozenPreface,
  resetPreface,
} from './preface.ts'
import type { PrefaceFs } from './preface.ts'

const diskFs: PrefaceFs = {
  readdir: path => readdir(path),
  mkdir: async path => {
    await mkdir(path, { recursive: true })
  },
  readFile: path => readFile(path, 'utf8'),
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  },
  unlink: path => unlink(path),
}

const validDraft = {
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
}

test('parsePreface accepts a valid rollout preface and an optimisation preface without known_total, tolerance or reconciliation', () => {
  const full = parsePreface(JSON.stringify(validDraft))
  expect('preface' in full && full.preface).toEqual(validDraft)

  const withoutKnown = {
    low: 0.05,
    high: 0.1,
    falsifiers: ['Holdout window 2026-10-01..2026-10-14 does not regress.'],
    answer: 'opt-rate',
    reconciliation: 'opt-total',
    specs: [
      { id: 'opt-rate', text: 'Optimisation rate spec.' },
      { id: 'opt-total', text: 'Optimisation total spec.' },
    ],
  }
  const opt = parsePreface(JSON.stringify({ ...withoutKnown, known_total: null, tolerance: 0 }))
  expect('preface' in opt && opt.preface).toEqual({ ...withoutKnown, tolerance: 0 })

  const optNoTol = parsePreface(JSON.stringify(withoutKnown))
  expect('preface' in optNoTol && optNoTol.preface).toEqual({ ...withoutKnown, tolerance: 0 })

  const optOmittedRecon = {
    low: 0.05,
    high: 0.1,
    falsifiers: ['Holdout window 2026-10-01..2026-10-14 does not regress.'],
    answer: 'opt-rate',
    specs: [{ id: 'opt-rate', text: 'Optimisation rate spec.' }],
  }
  const parsedOptOmitted = parsePreface(JSON.stringify(optOmittedRecon))
  expect('preface' in parsedOptOmitted && parsedOptOmitted.preface).toEqual({
    ...optOmittedRecon,
    tolerance: 0,
    reconciliation: '',
  })

  const parsedOptEmptyRecon = parsePreface(JSON.stringify({ ...optOmittedRecon, reconciliation: '   ' }))
  expect('preface' in parsedOptEmptyRecon && parsedOptEmptyRecon.preface).toEqual({
    ...optOmittedRecon,
    tolerance: 0,
    reconciliation: '',
  })

  const rolloutDefaultTol = parsePreface(JSON.stringify({ ...validDraft, tolerance: undefined }))
  expect('preface' in rolloutDefaultTol && rolloutDefaultTol.preface).toEqual({ ...validDraft, tolerance: 0 })
})

test('parsePreface rejects malformed JSON, bad bounds, missing falsifiers, duplicate or bad specs, and unknown spec references', () => {
  expect('error' in parsePreface('{')).toBe(true)
  expect('error' in parsePreface('[]')).toBe(true)
  expect('error' in parsePreface('null')).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, low: 'bad' }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, low: 0.5, high: 0.2 }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, known_total: 'bad' }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, tolerance: 'bad' }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, tolerance: -1 }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, known_total: undefined, tolerance: -1 }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, falsifiers: [] }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, falsifiers: ['   '] }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, falsifiers: [123] }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, specs: [] }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, specs: ['bad'] }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, specs: [{ id: '', text: 'x' }] }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, specs: [{ id: '-bad', text: 'x' }] }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, specs: [{ id: 'bad space', text: 'x' }] }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, specs: [{ id: 'rev (unfrozen)', text: 'x' }] }))).toBe(true)
  expect(
    'error' in
      parsePreface(
        JSON.stringify({
          ...validDraft,
          specs: [
            { id: 'rollout-rate', text: 'One' },
            { id: 'rollout-rate', text: 'Two' },
          ],
        }),
      ),
  ).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, answer: 'missing-id' }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, reconciliation: 'missing-id' }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, reconciliation: 123 }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, reconciliation: '' }))).toBe(true)
  expect('error' in parsePreface(JSON.stringify({ ...validDraft, known_total: undefined, reconciliation: 'missing-id' }))).toBe(true)
})

test('parseFrozenPreface requires a valid preface plus a 12-hex id and non-empty frozenAt', () => {
  expect(parseFrozenPreface('{')).toBeUndefined()
  expect(parseFrozenPreface('[]')).toBeUndefined()
  expect(parseFrozenPreface(JSON.stringify(validDraft))).toBeUndefined()
  expect(parseFrozenPreface(JSON.stringify({ ...validDraft, id: 'abc123def456', frozenAt: '   ' }))).toBeUndefined()
  expect(parseFrozenPreface(JSON.stringify({ ...validDraft, id: 'abc', frozenAt: '2026-11-14T10:00:00.000Z' }))).toBeUndefined()
  expect(parseFrozenPreface(JSON.stringify({ ...validDraft, id: '../../escape', frozenAt: '2026-11-14T10:00:00.000Z' }))).toBeUndefined()
  expect(parseFrozenPreface(JSON.stringify({ ...validDraft, id: 'ABC123DEF456', frozenAt: '2026-11-14T10:00:00.000Z' }))).toBeUndefined()
  expect(parseFrozenPreface(JSON.stringify({ ...validDraft, low: 5, high: 1, id: 'abc123def456', frozenAt: '2026-11-14T10:00:00.000Z' }))).toBeUndefined()
  const frozen = parseFrozenPreface(JSON.stringify({ ...validDraft, id: 'abc123def456', frozenAt: '2026-11-14T10:00:00.000Z' }))
  expect(frozen).toEqual({ ...validDraft, id: 'abc123def456', frozenAt: '2026-11-14T10:00:00.000Z' })
})

test('freezePreface validates and freezes preface.json, refuses a second freeze until reset, and resetPreface archives it', async () => {
  const analysis = await mkdtemp(join(tmpdir(), 'assay-preface-'))
  expect(await readFrozenPreface(diskFs, analysis)).toBeUndefined()

  const missing = await freezePreface(diskFs, analysis)
  expect(missing).toEqual({ ok: false, reason: 'invalid', message: `No draft preface: write ${PREFACE_DRAFT_FILE} in the analysis folder first.` })

  const unreset = await resetPreface(diskFs, analysis)
  expect(unreset).toEqual({ ok: false, reason: 'invalid', message: 'No frozen preface to reset.' })

  await writeFile(join(analysis, PREFACE_DRAFT_FILE), '{"low": 2, "high": 1}', 'utf8')
  const invalid = await freezePreface(diskFs, analysis)
  expect(invalid.ok).toBe(false)

  await writeFile(join(analysis, PREFACE_DRAFT_FILE), JSON.stringify(validDraft, null, 2), 'utf8')
  const t1 = new Date('2026-11-14T10:00:00.000Z')
  const first = await freezePreface(diskFs, analysis, t1)
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error('expected first freeze to succeed')
  expect(first.preface.id).toMatch(/^[0-9a-f]{12}$/)
  expect(first.preface.frozenAt).toBe('2026-11-14T10:00:00.000Z')

  const onDisk = await readFrozenPreface(diskFs, analysis)
  expect(onDisk).toEqual(first.preface)

  // A second freeze is refused while a preface is already frozen, even if the draft changes.
  await writeFile(join(analysis, PREFACE_DRAFT_FILE), JSON.stringify({ ...validDraft, low: 0.1, high: 0.2 }, null, 2), 'utf8')
  const second = await freezePreface(diskFs, analysis, new Date('2026-11-14T10:05:00.000Z'))
  expect(second).toEqual({ ok: false, reason: 'invalid', message: 'A preface is already frozen. Reset it before freezing a new one.' })
  expect(await readFrozenPreface(diskFs, analysis)).toEqual(first.preface)

  // Reset archives the frozen preface under .assay/preface-archive/<id>.json and clears the current frozen preface.
  const reset = await resetPreface(diskFs, analysis)
  expect(reset).toEqual({ ok: true, archived: first.preface })
  expect(await readFrozenPreface(diskFs, analysis)).toBeUndefined()
  const archivedText = await readFile(join(analysis, PREFACE_ARCHIVE_DIR, `${first.preface.id}.json`), 'utf8')
  expect(parseFrozenPreface(archivedText)).toEqual(first.preface)

  // After reset, a new draft can be frozen and gets a distinct id even at the same timestamp.
  const third = await freezePreface(diskFs, analysis, t1)
  expect(third.ok).toBe(true)
  if (!third.ok) throw new Error('expected freeze after reset to succeed')
  expect(third.preface.id).not.toBe(first.preface.id)
  expect(third.preface.low).toBe(0.1)
  expect(await readFile(join(analysis, FROZEN_PREFACE_FILE), 'utf8')).toContain(third.preface.id)
})

test('freezePreface and resetPreface report non-ENOENT filesystem errors as invalid', async () => {
  const analysis = await mkdtemp(join(tmpdir(), 'assay-preface-err-'))
  await writeFile(join(analysis, PREFACE_DRAFT_FILE), JSON.stringify(validDraft, null, 2), 'utf8')
  const failingFs: PrefaceFs = {
    ...diskFs,
    readFile: () => Promise.reject(new Error('refused link')),
    readdir: () => Promise.reject(new Error('refused dir')),
  }
  expect(await readFrozenPreface(failingFs, analysis)).toBeUndefined()
  expect(await freezePreface(failingFs, analysis)).toEqual({ ok: false, reason: 'invalid', message: 'refused link' })
  expect(await resetPreface(failingFs, analysis)).toEqual({ ok: false, reason: 'invalid', message: 'refused link' })
  const failingReaddirFs: PrefaceFs = {
    ...diskFs,
    readFile: path => (path.endsWith(FROZEN_PREFACE_FILE) ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })) : diskFs.readFile(path)),
    readdir: () => Promise.reject(new Error('refused archive dir')),
  }
  expect(await freezePreface(failingReaddirFs, analysis)).toEqual({ ok: false, reason: 'invalid', message: 'refused archive dir' })
})

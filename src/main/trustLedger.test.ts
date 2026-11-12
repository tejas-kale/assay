import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { addEntry, emptyLedger, isTrustedFile } from '../core/trustLedger.ts'
import { ledgerPath, readLedger, writeLedger } from './trustLedger.ts'

const A = 'a'.repeat(64)
const ledgerWith = () => addEntry(emptyLedger(), 'calc', { kind: 'calculation', files: { 'trusted/calc.sql': A }, approvedAt: 't', commit: '' })
const scratch = () => mkdtemp(join(tmpdir(), 'assay-ledger-'))

test('the ledger path is under the user data folder, named by the hash of the root', () => {
  const hash = createHash('sha256').update('/notes').digest('hex')
  assert.equal(ledgerPath('/ud', '/notes'), `/ud/trust-ledger/${hash}.json`)
})

test('a ledger written is read back, and no temporary file is left', async () => {
  const dir = await scratch()
  const path = ledgerPath(dir, '/notes')
  await writeLedger(path, ledgerWith())
  const { ledger, problem } = await readLedger(path)
  assert.equal(problem, undefined)
  assert.equal(isTrustedFile(ledger, 'trusted/calc.sql', A), true)
  assert.deepEqual(await readdir(join(dir, 'trust-ledger')), [basename(path)])
})

test('a missing ledger reads as empty without a problem; a damaged one as empty with one', async () => {
  const dir = await scratch()
  const path = ledgerPath(dir, '/notes')
  assert.deepEqual(await readLedger(path), { ledger: emptyLedger(), problem: undefined })
  await mkdir(join(dir, 'trust-ledger'))
  await writeFile(path, 'oops')
  const damaged = await readLedger(path)
  assert.deepEqual(damaged.ledger, emptyLedger())
  assert.equal(typeof damaged.problem, 'string')
})

test('a ledger file that is a link is refused for reading and writing, and the target is untouched', async () => {
  const dir = await scratch()
  const path = ledgerPath(dir, '/notes')
  await mkdir(join(dir, 'trust-ledger'))
  const target = join(dir, 'elsewhere.json')
  await writeFile(target, 'keep')
  await symlink(target, path)
  await assert.rejects(writeLedger(path, ledgerWith()), /link/)
  assert.equal(await readFile(target, 'utf8'), 'keep')
  const read = await readLedger(path)
  assert.deepEqual(read.ledger, emptyLedger())
  assert.match(read.problem ?? '', /link/)
})

test('a ledger folder that is a link is refused for writing', async () => {
  const dir = await scratch()
  const real = join(dir, 'real')
  await mkdir(real)
  await symlink(real, join(dir, 'trust-ledger'))
  await assert.rejects(writeLedger(ledgerPath(dir, '/notes'), ledgerWith()), /link/)
  assert.deepEqual(await readdir(real), [])
})

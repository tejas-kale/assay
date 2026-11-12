import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { TrustAdoptResult, TrustUnadoptedResult } from '../core/trustAdopt.ts'
import { isTrustedFile } from '../core/trustLedger.ts'
import { adoptGroup, listUnadopted } from './trustAdopt.ts'
import { ledgerPath, readLedger } from './trustLedger.ts'

const CODE = 'SELECT 1\n'
const TEST = 'cases: []\n'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

type World = { dir: string; root: string; ledgerFile: string }

/** A root holding trusted/ and dictionaries/ files from before the ledger existed. */
async function world(files: Record<string, string> = { 'trusted/calc.sql': CODE, 'trusted/calc.test.yaml': TEST, 'dictionaries/orders.yaml': 'columns: []\n' }): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'assay-adopt-'))
  const root = join(dir, 'root')
  await mkdir(join(root, 'trusted'), { recursive: true })
  await mkdir(join(root, 'dictionaries'), { recursive: true })
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text)
  return { dir, root, ledgerFile: ledgerPath(join(dir, 'ud'), root) }
}

const groups = (result: TrustUnadoptedResult) => {
  if (!result.ok) throw new Error(`refused: ${result.message}`)
  return result.groups
}
const refusal = (result: TrustAdoptResult | TrustUnadoptedResult) => {
  if (result.ok) throw new Error('not refused')
  return result.message
}
const adopt = (w: World, name = 'calc', kind: 'calculation' | 'dictionary' = 'calculation', hashes: Record<string, string> = { 'calc.sql': sha(CODE), 'calc.test.yaml': sha(TEST) }) =>
  adoptGroup({ root: w.root, ledgerFile: w.ledgerFile, input: { name, kind, hashes }, now: () => new Date('2026-11-12T10:00:00Z') })

test('with an empty ledger the files on disk are listed as groups, with their text and hashes', async () => {
  const w = await world()
  const listed = groups(await listUnadopted(w.root, w.ledgerFile))
  assert.deepEqual(
    listed.map(g => [g.kind, g.name, g.files.map(f => f.name)]),
    [
      ['calculation', 'calc', ['calc.sql', 'calc.test.yaml']],
      ['dictionary', 'orders', ['orders.yaml']],
    ],
  )
  assert.deepEqual(listed[0]?.files[0], { name: 'calc.sql', text: CODE, sha256: sha(CODE) })
})

test('links, folders and files that are not a group\'s own are not listed', async () => {
  const w = await world({ 'trusted/calc.sql': CODE, 'trusted/README.md': 'x' })
  await writeFile(join(w.dir, 'secret.sql'), 'secret')
  await symlink(join(w.dir, 'secret.sql'), join(w.root, 'trusted/linked.sql'))
  await mkdir(join(w.root, 'trusted/folder.sql'))
  await writeFile(join(w.root, 'trusted/Bad Name.sql'), 'x')
  assert.deepEqual(groups(await listUnadopted(w.root, w.ledgerFile)).map(g => g.name), ['calc'])
})

test('a shared folder that is a link is refused, and a missing one lists nothing', async () => {
  const w = await world({})
  await mkdir(join(w.dir, 'elsewhere'))
  await writeFile(join(w.dir, 'elsewhere/x.sql'), CODE)
  await rm(join(w.root, 'trusted'), { recursive: true })
  await symlink(join(w.dir, 'elsewhere'), join(w.root, 'trusted'), 'dir')
  assert.equal(refusal(await listUnadopted(w.root, w.ledgerFile)), 'trusted/ is a link: it is refused.')
  await rm(join(w.root, 'trusted'))
  await rm(join(w.root, 'dictionaries'), { recursive: true })
  assert.deepEqual(groups(await listUnadopted(w.root, w.ledgerFile)), [])
})

test('a file that is not UTF-8 is listed with a problem and cannot be adopted', async () => {
  const w = await world({ 'trusted/calc.sql': CODE })
  await writeFile(join(w.root, 'trusted/calc.sql'), Buffer.from([0xff, 0xfe, 0x00]))
  const [group] = groups(await listUnadopted(w.root, w.ledgerFile))
  assert.match(group?.problem ?? '', /not UTF-8/)
  const hash = group?.files[0]?.sha256 ?? ''
  assert.match(refusal(await adopt(w, 'calc', 'calculation', { 'calc.sql': hash })), /not UTF-8/)
})

test('adopting records the shown hashes in the ledger, with no commit, and changes no file and runs no git', async () => {
  const w = await world()
  await mkdir(join(w.root, '.git'))
  const before = (await readdir(w.root, { recursive: true })).toSorted((x, y) => x.localeCompare(y))
  const result = await adopt(w)
  assert.deepEqual(result, { ok: true, message: 'Adopted calc: it is trusted as it is now.' })
  const { ledger } = await readLedger(w.ledgerFile)
  assert.deepEqual(ledger.entries['calculation:calc'], {
    kind: 'calculation',
    files: { 'trusted/calc.sql': sha(CODE), 'trusted/calc.test.yaml': sha(TEST) },
    approvedAt: '2026-11-12T10:00:00.000Z',
    commit: '',
  })
  assert.equal(isTrustedFile(ledger, 'trusted/calc.sql', sha(CODE)), true)
  assert.deepEqual((await readdir(w.root, { recursive: true })).toSorted((x, y) => x.localeCompare(y)), before)
  assert.deepEqual(groups(await listUnadopted(w.root, w.ledgerFile)).map(g => g.name), ['orders'])
})

test('adopting a dictionary records it under dictionaries/', async () => {
  const w = await world()
  const result = await adopt(w, 'orders', 'dictionary', { 'orders.yaml': sha('columns: []\n') })
  assert.equal(result.ok, true)
  const { ledger } = await readLedger(w.ledgerFile)
  assert.deepEqual(Object.values(ledger.entries).map(entry => [entry.kind, Object.keys(entry.files)]), [['dictionary', ['dictionaries/orders.yaml']]])
})

test('adopting refuses when a file changed since it was shown, and records nothing', async () => {
  const w = await world()
  await writeFile(join(w.root, 'trusted/calc.sql'), 'SELECT 2\n')
  assert.match(refusal(await adopt(w)), /changed since you looked at it/)
  assert.deepEqual((await readLedger(w.ledgerFile)).ledger.entries, {})
})

test('adopting refuses a file that became a link, a group that is gone and a group already adopted', async () => {
  const w = await world()
  await writeFile(join(w.dir, 'secret.sql'), CODE)
  await rm(join(w.root, 'trusted/calc.sql'))
  await symlink(join(w.dir, 'secret.sql'), join(w.root, 'trusted/calc.sql'))
  assert.match(refusal(await adopt(w)), /"calc.sql" is a link/)
  assert.match(refusal(await adopt(w, 'nothing', 'calculation', { 'nothing.sql': sha(CODE) })), /Nothing to adopt/)
  const again = await world()
  assert.equal((await adopt(again)).ok, true)
  assert.match(refusal(await adopt(again)), /Nothing to adopt/)
})

test('adopting a changed file of an approved calculation replaces the entry and keeps the old one in history', async () => {
  const w = await world()
  await adopt(w)
  await writeFile(join(w.root, 'trusted/calc.sql'), 'SELECT 3\n')
  const result = await adopt(w, 'calc', 'calculation', { 'calc.sql': sha('SELECT 3\n'), 'calc.test.yaml': sha(TEST) })
  assert.equal(result.ok, true)
  const { ledger } = await readLedger(w.ledgerFile)
  assert.equal(ledger.history.length, 1)
  assert.equal(isTrustedFile(ledger, 'trusted/calc.sql', sha(CODE)), false)
})

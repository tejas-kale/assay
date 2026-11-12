import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RunRequest } from '../shared/ipc.ts'
import { endTrusted, startTrusted, trustAdoptFor, trustApproveFor, trustFilesFor, trustUnadoptedFor } from './trustContext.ts'
import type { TrustLaunch } from './trustContext.ts'
import { ledgerPath, readLedger } from './trustLedger.ts'

const CODE = 'SELECT 1\n'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Two roots, A and B, each with an analysis; the window's session was launched under A. */
async function roots() {
  const dir = await mkdtemp(join(tmpdir(), 'assay-ctx-'))
  const make = async (name: string) => {
    const root = join(dir, name)
    const analysisPath = join(root, 'analyses', 'x')
    await mkdir(join(analysisPath, 'lib/trusted'), { recursive: true })
    await mkdir(join(root, 'trusted'), { recursive: true })
    await writeFile(join(analysisPath, 'lib/trusted/calc.sql'), name === 'a' ? CODE : 'SELECT 2\n')
    await writeFile(join(root, 'trusted/old.sql'), 'SELECT 9\n')
    return { analysisPath, root, ledgerFile: ledgerPath(join(dir, 'ud'), root) } satisfies TrustLaunch
  }
  return { a: await make('a'), b: await make('b') }
}

test('approving from a window launched under root A records in A\'s ledger and tells A\'s analysis, whatever the settings root is now', async () => {
  const { a, b } = await roots()
  const told: [string, RunRequest][] = []
  const result = await trustApproveFor(a, { name: 'calc', kind: 'calculation', hashes: { 'calc.sql': sha(CODE) } }, (path, request) => {
    told.push([path, request])
    return Promise.resolve({ ok: true, id: '1' })
  })
  assert.equal(result.ok, true)
  assert.equal(isEntry((await readLedger(a.ledgerFile)).ledger.entries), true)
  assert.deepEqual((await readLedger(b.ledgerFile)).ledger.entries, {})
  assert.equal(await readdir(join(b.root, 'trusted')).then(files => files.join()), 'old.sql')
  assert.deepEqual(told.map(([path, request]) => [path, request.kind]), [[a.analysisPath, 'trust-done']])
})

test('an approval whose trust-done cannot be delivered says so, and pressing Trust again sends it again', async () => {
  const { a } = await roots()
  const input = { name: 'calc', kind: 'calculation', hashes: { 'calc.sql': sha(CODE) } }
  const told: RunRequest[] = []
  const down = (_path: string, request: RunRequest) => {
    told.push(request)
    return Promise.resolve({ ok: false as const, message: 'disk full' })
  }
  const first = await trustApproveFor(a, input, down)
  assert.equal(first.ok, false)
  assert.match(first.message, /^Your approval is recorded; Claude's side was not told \(disk full\), press Trust again to retry\.$/)
  assert.equal(Object.keys((await readLedger(a.ledgerFile)).ledger.entries).join(), 'calculation:calc')
  const second = await trustApproveFor(a, input, (_path, request) => {
    told.push(request)
    return Promise.resolve({ ok: true, id: '2' })
  })
  assert.equal(second.ok, true)
  assert.deepEqual(told.map(request => request.kind === 'trust-done' && request.outcome), ['approved', 'unchanged'])
})

const isEntry = (entries: object) => Object.keys(entries).join() === 'calculation:calc'

test('the draft shown and the files adoptable are those of the launched root', async () => {
  const { a } = await roots()
  const shown = await trustFilesFor(a, { name: 'calc', kind: 'calculation' })
  assert.deepEqual(shown, { ok: true, files: [{ name: 'calc.sql', text: CODE, sha256: sha(CODE) }] })
  const listed = await trustUnadoptedFor(a)
  assert.deepEqual(listed.ok && listed.groups.map(group => group.name), ['old'])
  const adopted = await trustAdoptFor(a, { name: 'old', kind: 'calculation', hashes: { 'old.sql': sha('SELECT 9\n') } })
  assert.equal(adopted.ok, true)
  assert.equal((await readLedger(a.ledgerFile)).ledger.entries['calculation:old']?.files['trusted/old.sql'], sha('SELECT 9\n'))
})

test('a window with no launched session is refused by every Trust call, and nothing is read or written', async () => {
  const tell = () => {
    throw new Error('must not tell the server')
  }
  const refused = { ok: false, message: 'The analysis has no Claude session yet: start it before using the Trust tab.' }
  assert.deepEqual(await trustFilesFor(undefined, { name: 'calc', kind: 'calculation' }), refused)
  assert.deepEqual(await trustApproveFor(undefined, { name: 'calc', kind: 'calculation', hashes: { 'calc.sql': sha(CODE) } }, tell), refused)
  assert.deepEqual(await trustUnadoptedFor(undefined), refused)
  assert.deepEqual(await trustAdoptFor(undefined, { name: 'old', kind: 'calculation', hashes: { 'old.sql': sha(CODE) } }), refused)
})

test('bad input is refused with the launch present, and a refused approval tells the server nothing', async () => {
  const { a } = await roots()
  const tell = () => {
    throw new Error('must not tell the server')
  }
  assert.deepEqual(await trustFilesFor(a, { name: '../x', kind: 'calculation' }), { ok: false, message: 'Invalid proposal' })
  assert.equal((await trustApproveFor(a, { name: 'calc', kind: 'calculation', hashes: { 'calc.sql': sha('other') } }, tell)).ok, false)
  assert.equal((await trustApproveFor(a, { name: 'calc' }, tell)).ok, false)
  assert.equal((await trustAdoptFor(a, { name: 'x' })).ok, false)
  assert.equal(await readFile(a.ledgerFile).then(() => true, () => false), false)
})

test('the Trust calls are bound only after the session started, and unbound when it ends or fails to start', async () => {
  const { a } = await roots()
  const holder: { trustLaunch?: TrustLaunch } = {}
  assert.throws(() => startTrusted(holder, a, () => {
    throw new Error('spawn failed')
  }), /spawn failed/)
  assert.equal(holder.trustLaunch, undefined)
  assert.equal(startTrusted(holder, a, () => 'session'), 'session')
  assert.equal(holder.trustLaunch, a)
  endTrusted(holder)
  assert.equal(holder.trustLaunch, undefined)
  assert.equal((await trustApproveFor(holder.trustLaunch, { name: 'calc' }, () => Promise.resolve({ ok: true, id: '1' }))).ok, false)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isTrustedFile } from '../core/trustLedger.ts'
import type { TrustApproveResult, TrustFilesResult } from '../core/trustApprove.ts'
import { approveProposal, readDraft } from './trustApprove.ts'
import { ledgerPath, readLedger } from './trustLedger.ts'

const CODE = 'SELECT 1\n'
const TEST = 'cases: []\n'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

type World = { dir: string; root: string; analysis: string; ledgerFile: string }

/** A root with an analysis holding a drafted calculation, and a ledger path outside both. */
async function world(options: { draft?: Record<string, string> } = {}): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'assay-approve-'))
  const root = join(dir, 'root')
  const analysis = join(root, 'analyses', 'a')
  await mkdir(join(analysis, 'lib/trusted'), { recursive: true })
  for (const [file, text] of Object.entries(options.draft ?? { 'calc.sql': CODE, 'calc.test.yaml': TEST })) await writeFile(join(analysis, 'lib/trusted', file), text)
  return { dir, root, analysis, ledgerFile: ledgerPath(join(dir, 'ud'), root) }
}

const shown = { 'calc.sql': sha(CODE), 'calc.test.yaml': sha(TEST) }
const approve = (w: World, hashes: Record<string, string> = shown, name = 'calc') =>
  approveProposal({ analysisPath: w.analysis, ledgerFile: w.ledgerFile, input: { name, kind: 'calculation', hashes }, now: () => new Date('2026-11-12T10:00:00Z') })
/** The accepted result, or a failure that says what main refused. */
const accepted = (result: TrustApproveResult) => {
  if (!result.ok) throw new Error(`refused: ${result.message}`)
  return result
}
/** What main said when it refused, or a failure when it approved. */
const refusal = (result: TrustApproveResult | TrustFilesResult) => {
  if (result.ok) throw new Error('approved or shown, not refused')
  return result.message
}
const byName = (a: string, b: string) => a.localeCompare(b)
const exists = (path: string) => readFile(path, 'utf8').then(() => true, () => false)
/** Every path under the root, so a test can say nothing was written there. */
const tree = async (w: World) => (await readdir(w.root, { recursive: true })).sort(byName)

test('the Trust tab sees the proposal\'s own files as main reads them, with their hashes', async () => {
  const w = await world({ draft: { 'calc.sql': CODE, 'calc.test.yaml': TEST, 'other.sql': 'not mine', 'notes.md': 'x' } })
  assert.deepEqual(await readDraft(w.analysis, 'calculation', 'calc'), {
    ok: true,
    files: [
      { name: 'calc.sql', text: CODE, sha256: sha(CODE) },
      { name: 'calc.test.yaml', text: TEST, sha256: sha(TEST) },
    ],
  })
  const none = await readDraft(w.analysis, 'dictionary', 'a.b.c')
  assert.deepEqual(none, { ok: false, message: 'No files of a.b.c in lib/dictionaries/.' })
})

test('a draft that is a link, holds a link or is not UTF-8 is refused, and shows nothing', async () => {
  const w = await world({ draft: { 'calc.test.yaml': TEST } })
  await writeFile(join(w.dir, 'secret'), 'secret')
  await symlink(join(w.dir, 'secret'), join(w.analysis, 'lib/trusted/calc.sql'))
  assert.match(refusal(await readDraft(w.analysis, 'calculation', 'calc')), /"calc.sql" in lib\/trusted\/ is a link/)
  const binary = await world({ draft: { 'calc.sql': '' } })
  await writeFile(join(binary.analysis, 'lib/trusted/calc.sql'), Buffer.from([0xff, 0xfe, 0x00]))
  assert.match(refusal(await readDraft(binary.analysis, 'calculation', 'calc')), /not UTF-8/)
  const folder = await world({ draft: {} })
  await mkdir(join(folder.dir, 'elsewhere'))
  await writeFile(join(folder.dir, 'elsewhere/calc.sql'), CODE)
  await rm(join(folder.analysis, 'lib/trusted'), { recursive: true })
  await symlink(join(folder.dir, 'elsewhere'), join(folder.analysis, 'lib/trusted'), 'dir')
  assert.deepEqual(await readDraft(folder.analysis, 'calculation', 'calc'), { ok: false, message: 'lib/trusted/ is a link: it is refused.' })
})

test('Trust records the shown hashes in the ledger and writes nothing else: the root and the draft are untouched', async () => {
  const w = await world()
  const before = await tree(w)
  const result = accepted(await approve(w))
  assert.equal(result.outcome, 'approved')
  assert.equal(result.message, "Trusted calc: approved in the app; Claude's side now copies it to trusted/.")
  const { ledger, problem } = await readLedger(w.ledgerFile)
  assert.equal(problem, undefined)
  assert.deepEqual(ledger.entries['calculation:calc'], { kind: 'calculation', files: { 'trusted/calc.sql': sha(CODE), 'trusted/calc.test.yaml': sha(TEST) }, approvedAt: '2026-11-12T10:00:00.000Z', commit: '' })
  assert.equal(isTrustedFile(ledger, 'trusted/calc.sql', sha(CODE)), true)
  assert.deepEqual(await tree(w), before)
  assert.equal(await readFile(join(w.analysis, 'lib/trusted/calc.sql'), 'utf8'), CODE)
  assert.equal(await exists(join(w.root, 'trusted')), false)
  assert.equal(await exists(join(w.root, '.git')), false)
})

test('main never runs git or writes into the root: a hostile .git/config and hooks in the root are never reached', async () => {
  const w = await world()
  await mkdir(join(w.root, '.git/hooks'), { recursive: true })
  await writeFile(join(w.root, '.git/config'), '[core]\n\tfsmonitor = touch /tmp/pwned\n')
  await writeFile(join(w.root, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch /tmp/pwned\n')
  accepted(await approve(w))
  assert.equal(await readFile(join(w.root, '.git/config'), 'utf8'), '[core]\n\tfsmonitor = touch /tmp/pwned\n')
  const sources = await Promise.all(['trustApprove.ts', 'trustAdopt.ts', 'trustContext.ts'].map(file => readFile(join(import.meta.dirname, file), 'utf8')))
  for (const source of sources) assert.doesNotMatch(source, /child_process|usr\/bin\/git/)
})

test('a draft changed after it was shown is refused: nothing is copied, committed or recorded', async () => {
  const w = await world()
  await writeFile(join(w.analysis, 'lib/trusted/calc.sql'), 'SELECT evil\n')
  assert.match(refusal(await approve(w)), /^The draft changed since you looked at it/)
  assert.equal(await exists(w.ledgerFile), false)
})

test('a file added to or missing from the draft, since it was shown, is refused too', async () => {
  const added = await world()
  await writeFile(join(added.analysis, 'lib/trusted/test_calc.py'), 'print(1)\n')
  assert.equal((await approve(added)).ok, false)
  const missing = await world({ draft: { 'calc.sql': CODE } })
  assert.equal((await approve(missing)).ok, false)
  assert.equal(await exists(missing.ledgerFile), false)
})

test('a draft file or folder that is a link is refused, and nothing is recorded', async () => {
  const draft = await world({ draft: { 'calc.test.yaml': TEST } })
  await writeFile(join(draft.dir, 'secret.sql'), 'secret\n')
  await symlink(join(draft.dir, 'secret.sql'), join(draft.analysis, 'lib/trusted/calc.sql'))
  refusal(await approve(draft))
  assert.equal(await exists(draft.ledgerFile), false)

  const folder = await world({ draft: {} })
  await mkdir(join(folder.dir, 'elsewhere'))
  await writeFile(join(folder.dir, 'elsewhere/calc.sql'), CODE)
  await rm(join(folder.analysis, 'lib/trusted'), { recursive: true })
  await symlink(join(folder.dir, 'elsewhere'), join(folder.analysis, 'lib/trusted'), 'dir')
  refusal(await approve(folder, { 'calc.sql': sha(CODE) }))
  assert.equal(await exists(folder.ledgerFile), false)
})

test('a name that is not the proposal\'s own is never read, copied or recorded', async () => {
  const w = await world({ draft: { 'calc.sql': CODE, 'evil.sql': 'evil\n' } })
  refusal(await approve(w, { 'calc.sql': sha(CODE), 'evil.sql': sha('evil\n') }))
  assert.equal(await exists(w.ledgerFile), false)
})

test('approving files the ledger already holds is "unchanged" and writes no new entry', async () => {
  const w = await world()
  await approve(w)
  const again = accepted(await approve(w))
  assert.equal(again.outcome, 'unchanged')
  assert.equal(again.message, 'Already trusted: no changes.')
  assert.equal((await readLedger(w.ledgerFile)).ledger.history.length, 0)
})

test('a new approval of the same name replaces its entry and keeps the old one in history', async () => {
  const w = await world()
  await approve(w)
  await writeFile(join(w.analysis, 'lib/trusted/calc.sql'), 'SELECT 2\n')
  assert.equal(accepted(await approve(w, { 'calc.sql': sha('SELECT 2\n'), 'calc.test.yaml': sha(TEST) })).outcome, 'approved')
  const { ledger } = await readLedger(w.ledgerFile)
  assert.equal(ledger.entries['calculation:calc']?.files['trusted/calc.sql'], sha('SELECT 2\n'))
  assert.equal(ledger.history.length, 1)
  assert.equal(ledger.history[0]?.files['trusted/calc.sql'], sha(CODE))
})

test('a ledger that is a link records nothing, and the proposal is not trusted', async () => {
  const w = await world()
  await mkdir(join(w.dir, 'ud/trust-ledger'), { recursive: true })
  await writeFile(join(w.dir, 'real.json'), '{}')
  await symlink(join(w.dir, 'real.json'), w.ledgerFile)
  assert.match(refusal(await approve(w)), /is not trusted/)
  assert.equal(await readFile(join(w.dir, 'real.json'), 'utf8'), '{}')
})

test('two approvals at once both reach the ledger', async () => {
  const w = await world()
  await writeFile(join(w.analysis, 'lib/trusted/other.sql'), 'SELECT 3\n')
  const [a, b] = await Promise.all([approve(w), approve(w, { 'other.sql': sha('SELECT 3\n') }, 'other')])
  accepted(a)
  accepted(b)
  const { ledger } = await readLedger(w.ledgerFile)
  assert.deepEqual(Object.keys(ledger.entries).sort(byName), ['calculation:calc', 'calculation:other'])
})

test('a dictionary entry is recorded under dictionaries/', async () => {
  const w = await world({ draft: {} })
  await mkdir(join(w.analysis, 'lib/dictionaries'), { recursive: true })
  await writeFile(join(w.analysis, 'lib/dictionaries/a.b.c.yaml'), 'description: x\n')
  accepted(await approveProposal({ analysisPath: w.analysis, ledgerFile: w.ledgerFile, input: { name: 'a.b.c', kind: 'dictionary', hashes: { 'a.b.c.yaml': sha('description: x\n') } } }))
  assert.equal((await readLedger(w.ledgerFile)).ledger.entries['dictionary:a.b.c']?.files['dictionaries/a.b.c.yaml'], sha('description: x\n'))
  assert.equal((await readLedger(w.ledgerFile)).ledger.entries['dictionary:a.b.c']?.kind, 'dictionary')
})

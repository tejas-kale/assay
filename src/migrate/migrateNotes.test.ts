// The notes migration run as a command on a scratch root, compared to the expected tree.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { expect } from '../testing/expect.ts'

const run = promisify(execFile)
const at = (h: number, m: number, s: number) => new Date(2026, 5, 1, h, m, s)

async function put(root: string, path: string, text: string, when?: Date) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), text)
  if (when) await utimes(join(root, path), when, when)
}

/** Two migrated analyses (alpha, beta), the old note formats in both, and a root note already at beta's first ID. */
async function scratchRoot() {
  const root = join(await mkdtemp(join(tmpdir(), 'assay-migrate-notes-')), 'notes-src')
  await put(root, 'analyses/alpha/analysis.yaml', 'title: Alpha\ncreated: 2026-03-05\n')
  await put(root, 'analyses/alpha/notes.md', ['Churn is 4% [trusted q 007]', 'Orders look flat [queried q 5]', 'Maybe seasonal [unverified]', 'Cited bare [q 12]', 'Plain line', '[Cohort sizes](<notes/001-cohorts.md>)', ''].join('\n'), at(10, 0, 30))
  await put(root, 'analyses/alpha/notes/001-cohorts.md', '# Cohort sizes\n\nSee [[retention]] and [[003-model]]. Gone: [[missing]].\n\nRun [q 3] gave this.\n\n```\n[[retention]] [q 9]\n```\n', at(9, 0, 0))
  await put(root, 'analyses/alpha/notes/002-retention.md', '# Retention\n\nBack to [[001-cohorts]].\n', at(9, 0, 0))
  await put(root, 'analyses/alpha/notes/003-model.md', 'No title line, cites [q 4].\n', at(9, 5, 0))
  await put(root, 'analyses/beta/analysis.yaml', 'title: Beta\nnotes:\n  written: [20260601T080000]\n  found: []\n')
  await put(root, 'analyses/beta/notes.md', 'Beta fact [queried q 1]\n', at(9, 0, 1))
  await put(root, 'analyses/gamma/analysis.yaml', 'title: Gamma\n')
  await put(root, 'notes/20260601T090001-beta-fact-is-taken.md', '# Taken\n')
  return root
}

async function tree(root: string, at = ''): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    const path = at ? `${at}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(found, await tree(root, path))
    else found[path] = await readFile(join(root, path), 'utf8')
  }
  return found
}

const migrate = (root: string, ...flags: string[]) => run(process.execPath, [resolve('scripts/migrate-notes.ts'), root, ...flags]).then(out => out.stdout)

test('a dry run prints one line per note, the unresolved links, and writes nothing', async () => {
  const root = await scratchRoot()
  const before = await tree(root)
  const out = await migrate(root)
  expect(await tree(root)).toEqual(before)
  expect(out).toContain('alpha: notes/001-cohorts.md -> notes/20260601T090000-cohort-sizes.md\n')
  expect(out).toContain('alpha: notes/002-retention.md -> notes/20260601T090002-retention.md\n')
  expect(out).toContain('alpha: notes/003-model.md -> notes/20260601T090500-model.md\n')
  expect(out).toContain('alpha: notes.md line 1 -> notes/20260601T100024-churn-is-4.md\n')
  expect(out).toContain('alpha: notes.md line 6 -> notes/20260601T100029-cohort-sizes.md\n')
  expect(out).toContain('alpha: list 9 notes under notes.written, remove notes.md, notes\n')
  expect(out).toContain('Unresolved links (left as written):\n  alpha: notes/001-cohorts.md links [[missing]]\n')
  expect(out).toContain('Dry run: nothing changed.')
})

test('--apply writes root notes, lists them under notes.written, then removes notes.md and notes/', async () => {
  const root = await scratchRoot()
  const out = await migrate(root, '--apply')
  expect(out).toContain('Applied: 10 notes in 2 analyses.')
  expect(await tree(root)).toEqual({
    'analyses/alpha/analysis.yaml':
      'title: Alpha\ncreated: 2026-03-05\nnotes:\n  written: [20260601T090000, 20260601T090002, 20260601T090500, 20260601T100024, 20260601T100025, 20260601T100026, 20260601T100027, 20260601T100028, 20260601T100029]\n  found: []\n',
    'analyses/beta/analysis.yaml': 'title: Beta\nnotes:\n  written: [20260601T080000, 20260601T090003]\n  found: []\n',
    'analyses/gamma/analysis.yaml': 'title: Gamma\n',
    'notes/20260601T090000-cohort-sizes.md':
      '# Cohort sizes\n\nSee [[20260601T090002]] and [[20260601T090500]]. Gone: [[missing]].\n\nRun [alpha q 3] gave this.\n\n```\n[[retention]] [q 9]\n```\n',
    'notes/20260601T090002-retention.md': '# Retention\n\nBack to [[20260601T090000]].\n',
    'notes/20260601T090001-beta-fact-is-taken.md': '# Taken\n',
    'notes/20260601T090003-beta-fact.md': '# Beta fact\n\nBeta fact [beta q 1]\n',
    'notes/20260601T090500-model.md': '# model\n\nNo title line, cites [alpha q 4].\n',
    'notes/20260601T100024-churn-is-4.md': '# Churn is 4%\n\nChurn is 4% [alpha q 7]\n',
    'notes/20260601T100025-orders-look-flat.md': '# Orders look flat\n\nOrders look flat [alpha q 5]\n',
    'notes/20260601T100026-maybe-seasonal.md': '# Maybe seasonal\n\nMaybe seasonal\n',
    'notes/20260601T100027-cited-bare.md': '# Cited bare\n\nCited bare [alpha q 12]\n',
    'notes/20260601T100028-plain-line.md': '# Plain line\n\nPlain line\n',
    'notes/20260601T100029-cohort-sizes.md': '# Cohort sizes\n\n[Cohort sizes](<notes/001-cohorts.md>)\n',
  })
})

test('a rerun changes nothing', async () => {
  const root = await scratchRoot()
  await migrate(root, '--apply')
  const once = await tree(root)
  const out = await migrate(root, '--apply')
  expect(await tree(root)).toEqual(once)
  expect(out).toContain('Nothing to migrate.')
})

test('it refuses while slice 6 is not applied', async () => {
  const root = await scratchRoot()
  await put(root, 'investigations/old/.analysis', '')
  const failed = await migrate(root, '--apply').then(() => undefined, (error: { code: number; stderr: string }) => error)
  expect(failed?.code).toBe(2)
  expect(failed?.stderr).toContain('migrate:root')
  expect(await readdir(join(root, 'analyses/alpha'))).toContain('notes.md')
})

// A crash at any write leaves a partial state; a rerun must reach the uninterrupted result.
test('a rerun after a crash at any point ends where an uninterrupted run ends', async () => {
  const { applyPlan, nodeApplyFs, planNotes, nodeFsPort } = await import('./migrateNotes.ts')
  const whole = await scratchRoot()
  let steps = 0
  await applyPlan(whole, await planNotes(nodeFsPort, whole), {
    ...nodeApplyFs,
    mkdir: path => (steps++, nodeApplyFs.mkdir(path)),
    createFile: (path, text) => (steps++, nodeApplyFs.createFile(path, text)),
    writeFile: (path, text) => (steps++, nodeApplyFs.writeFile(path, text)),
    remove: path => (steps++, nodeApplyFs.remove(path)),
  })
  const expected = await tree(whole)
  expect(steps > 10).toBe(true)

  for (let crashAt = 0; crashAt < steps; crashAt++) {
    const root = await scratchRoot()
    let count = 0
    const tick = () => {
      if (count++ === crashAt) throw new Error('crash')
    }
    const crashing = {
      ...nodeApplyFs,
      mkdir: (path: string) => (tick(), nodeApplyFs.mkdir(path)),
      createFile: (path: string, text: string) => (tick(), nodeApplyFs.createFile(path, text)),
      writeFile: (path: string, text: string) => (tick(), nodeApplyFs.writeFile(path, text)),
      remove: (path: string) => (tick(), nodeApplyFs.remove(path)),
    }
    await applyPlan(root, await planNotes(nodeFsPort, root), crashing).then(() => undefined, () => undefined)
    await applyPlan(root, await planNotes(nodeFsPort, root))
    expect(await tree(root)).toEqual(expected)
    // And a further rerun finds nothing to do.
    expect((await planNotes(nodeFsPort, root)).analyses).toEqual([])
  }
})

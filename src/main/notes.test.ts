import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadState } from './files.ts'
import { addRootNote, currentCommit, readCitedRun, readRootNote, saveRootNote } from './notes.ts'

/** A root with analysis `a` (and `b` holding runs when asked). */
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'assay-root-'))
  const path = join(root, 'analyses', 'a')
  await mkdir(join(path, 'queries'), { recursive: true })
  await writeFile(join(path, 'analysis.yaml'), 'title: A\n')
  return { root, analysis: { name: 'a', title: 'A', path } }
}

test('add writes a root note named by time and slug, qualifies bare citations and lists it as written', async () => {
  const { root, analysis } = await scratch()
  const now = new Date(2026, 10, 2, 18, 15, 0)
  const first = await addRootNote(root, analysis, 'Churn by  region', 'It is 4% [q 3].\n```\n[q 9]\n```', now)
  assert.deepEqual(first, { ok: true, name: '20261102T181500-churn-by-region.md' })
  assert.equal(await readFile(join(root, 'notes', first.ok ? first.name : ''), 'utf8'), '# Churn by region\n\nIt is 4% [a q 3].\n```\n[q 9]\n```\n')
  // The same second again bumps the ID.
  assert.deepEqual(await addRootNote(root, analysis, 'Second', '', now), { ok: true, name: '20261102T181501-second.md' })
  assert.equal(await readFile(join(analysis.path, 'analysis.yaml'), 'utf8'), 'title: A\nnotes:\n  written: [20261102T181500, 20261102T181501]\n  found: []\n')
  assert.equal((await addRootNote(root, analysis, '   ', 'x', now)).ok, false)
  assert.equal((await readdir(join(root, 'notes'))).length, 2)
})

test('loadState holds every root note and this analysis lists', async () => {
  const { root, analysis } = await scratch()
  await addRootNote(root, analysis, 'Mine', 'x', new Date(2026, 10, 2, 9, 0, 0))
  await writeFile(join(root, 'notes', '20261001T090000-other.md'), '# Other\n\nSee [[20261102T090000]].\n')
  const state = await loadState(analysis)
  assert.deepEqual(state.rootNotes.map(n => [n.id, n.title, n.links]), [['20261001T090000', 'Other', ['20261102T090000']], ['20261102T090000', 'Mine', []]])
  assert.deepEqual(state.noteLists, { written: ['20261102T090000'], found: [] })
})

test('save writes only when the file still holds the expected text', async () => {
  const { root, analysis } = await scratch()
  const made = await addRootNote(root, analysis, 'T', 'one', new Date(2026, 10, 2, 9, 0, 0))
  const name = made.ok ? made.name : ''
  assert.deepEqual(await saveRootNote(root, name, '# T\n\none\n', '# T\n\ntwo\n'), { ok: true })
  assert.equal(await readFile(join(root, 'notes', name), 'utf8'), '# T\n\ntwo\n')
  const stale = await saveRootNote(root, name, '# T\n\none\n', '# T\n\nthree\n')
  assert.deepEqual(stale, { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' })
  assert.equal((await saveRootNote(root, '../analyses/a/analysis.yaml', '', 'x')).ok, false)
})

test('read derives labels from the cited runs: missing, queried, trusted, stale', async () => {
  const { root, analysis } = await scratch()
  const sh = (...args: string[]) => execFileSync('git', ['-C', join(root, 'trusted'), ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim()
  await mkdir(join(root, 'trusted'))
  sh('init', '-q')
  await writeFile(join(root, 'trusted', 'churn.sql'), 'select 1\n')
  sh('add', '.')
  sh('commit', '-q', '-m', 'x')
  const commit = sh('rev-parse', 'HEAD').slice(0, 12)
  assert.equal(await currentCommit(root, 'churn'), commit)
  assert.equal(await currentCommit(root, 'nothing'), undefined)

  const queries = join(analysis.path, 'queries')
  await writeFile(join(queries, '001_plain.sql'), 'select 1\n')
  await writeFile(join(queries, '001_plain.csv'), 'x\n1\n')
  await writeFile(join(queries, '002_churn.sql'), `-- trusted: churn\n-- args: {}\n-- commit: ${commit}\nselect 1\n`)
  await writeFile(join(queries, '002_churn.csv'), 'x\n1\n')
  await writeFile(join(queries, '003_old.sql'), '-- trusted: churn\n-- args: {}\n-- commit: 000000000000\nselect 1\n')
  await writeFile(join(queries, '003_old.csv'), 'x\n1\n')
  const made = await addRootNote(root, analysis, 'N', '[q 1] [q 2] [q 3] [q 4] [gone q 1]', new Date(2026, 10, 2, 9, 0, 0))
  const read = await readRootNote(root, made.ok ? made.name : '')
  assert.ok(read.ok)
  assert.deepEqual(read.ok && read.labels, { 'a q 1': 'queried', 'a q 2': 'trusted', 'a q 3': 'stale', 'a q 4': 'missing', 'gone q 1': 'missing' })
  assert.equal((await readRootNote(root, 'x.md')).ok, false)
})

test('a cited run is read from any analysis under the root, and only by a plain slug', async () => {
  const { root } = await scratch()
  const other = join(root, 'analyses', 'b', 'queries')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, '005_x.sql'), 'select 5\n')
  await writeFile(join(other, '005_x.csv'), 'n\n5\n')
  const view = await readCitedRun(root, 'b', 5)
  assert.equal(view?.code, 'select 5\n')
  assert.deepEqual(view?.table?.rows, [['5']])
  assert.equal(await readCitedRun(root, '..', 5), undefined)
  assert.equal(await readCitedRun(root, 'b', 6), undefined)
})

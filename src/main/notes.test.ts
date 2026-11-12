import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { loadState } from './files.ts'
import { addRootNote, readCitedRun, readRootNote, saveRootNote } from './notes.ts'

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
  const first = await addRootNote(root, analysis, { title: 'Churn by  region', body: 'It is 4% [q 3].\n```\n[q 9]\n```', now })
  assert.deepEqual(first, { ok: true, name: '20261102T181500-churn-by-region.md' })
  assert.equal(await readFile(join(root, 'notes', first.name), 'utf8'), '# Churn by region\n\nIt is 4% [a q 3].\n```\n[q 9]\n```\n')
  // The same second again bumps the ID.
  assert.deepEqual(await addRootNote(root, analysis, { title: 'Second', body: '', now }), { ok: true, name: '20261102T181501-second.md' })
  assert.equal(await readFile(join(analysis.path, 'analysis.yaml'), 'utf8'), 'title: A\nnotes:\n  written: [20261102T181500, 20261102T181501]\n  found: []\n')
  assert.equal((await addRootNote(root, analysis, { title: '   ', body: 'x', now })).ok, false)
  assert.equal((await readdir(join(root, 'notes'))).length, 2)
})

test('loadState holds every root note and this analysis lists', async () => {
  const { root, analysis } = await scratch()
  await addRootNote(root, analysis, { title: 'Mine', body: 'x', now: new Date(2026, 10, 2, 9, 0, 0) })
  await writeFile(join(root, 'notes', '20261001T090000-other.md'), '# Other\n\nSee [[20261102T090000]].\n')
  const state = await loadState(analysis)
  assert.deepEqual(state.rootNotes.map(n => [n.id, n.title, n.links]), [['20261001T090000', 'Other', ['20261102T090000']], ['20261102T090000', 'Mine', []]])
  assert.deepEqual(state.noteLists, { written: ['20261102T090000'], found: [] })
})

test('save writes only when the file still holds the expected text', async () => {
  const { root, analysis } = await scratch()
  const made = await addRootNote(root, analysis, { title: 'T', body: 'one', now: new Date(2026, 10, 2, 9, 0, 0) })
  const name = made.ok ? made.name : ''
  assert.deepEqual(await saveRootNote(root, name, '# T\n\none\n', '# T\n\ntwo\n'), { ok: true })
  assert.equal(await readFile(join(root, 'notes', name), 'utf8'), '# T\n\ntwo\n')
  const stale = await saveRootNote(root, name, '# T\n\none\n', '# T\n\nthree\n')
  assert.deepEqual(stale, { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' })
  assert.equal((await saveRootNote(root, '../analyses/a/analysis.yaml', '', 'x')).ok, false)
})

test('read derives labels from the cited runs: missing, queried, trusted, stale', async () => {
  const { root, analysis } = await scratch()
  const run = promisify(execFile)
  const sh = async (...args: string[]) => (await run('git', ['-C', join(root, 'trusted'), ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })).stdout.trim()
  await mkdir(join(root, 'trusted'))
  await sh('init', '-q')
  await writeFile(join(root, 'trusted', 'churn.sql'), 'select 1\n')
  await sh('add', '.')
  await sh('commit', '-q', '-m', 'x')
  const commit = (await sh('rev-parse', 'HEAD')).slice(0, 12)

  const queries = join(analysis.path, 'queries')
  await writeFile(join(queries, '001_plain.sql'), 'select 1\n')
  await writeFile(join(queries, '001_plain.csv'), 'x\n1\n')
  await writeFile(join(queries, '002_churn.sql'), `-- trusted: churn\n-- args: {}\n-- commit: ${commit}\nselect 1\n`)
  await writeFile(join(queries, '002_churn.csv'), 'x\n1\n')
  await writeFile(join(queries, '003_old.sql'), '-- trusted: churn\n-- args: {}\n-- commit: 000000000000\nselect 1\n')
  await writeFile(join(queries, '003_old.csv'), 'x\n1\n')
  const made = await addRootNote(root, analysis, { title: 'N', body: '[q 1] [q 2] [q 3] [q 4] [gone q 1]', now: new Date(2026, 10, 2, 9, 0, 0) })
  const read = await readRootNote(root, made.ok ? made.name : '')
  assert.ok(read.ok)
  assert.deepEqual(read.labels, { 'a q 1': 'queried', 'a q 2': 'trusted', 'a q 3': 'stale', 'a q 4': 'missing', 'gone q 1': 'missing' })
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
  assert.deepEqual(view.table?.rows, [['5']])
  assert.equal(await readCitedRun(root, '..', 5), undefined)
  assert.equal(await readCitedRun(root, 'b', 6), undefined)
})

test('a note file that is a link is neither shown nor saved (audit UI-6)', async () => {
  const { root } = await scratch()
  const secret = join(root, 'secret.txt')
  await writeFile(secret, 'token\n')
  await mkdir(join(root, 'notes'), { recursive: true })
  const name = '20261102T090000-linked.md'
  await symlink(secret, join(root, 'notes', name))
  const read = await readRootNote(root, name)
  assert.equal(read.ok, false)
  assert.equal((await saveRootNote(root, name, 'token\n', 'x')).ok, false)
  assert.equal(await readFile(secret, 'utf8'), 'token\n')
})

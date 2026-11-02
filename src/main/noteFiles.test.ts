import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createNoteFile, deleteNoteFile, loadState, readNoteFileByName, readNoteFiles, saveNoteFile } from './files.ts'

const folder = () => mkdtemp(join(tmpdir(), 'assay-notes-'))

test('create derives number and slug, never reuses a slug, and creates notes/', async () => {
  const dir = await folder()
  assert.deepEqual(await createNoteFile(dir, 'Churn by Region'), { ok: true, name: '001-churn-by-region.md' })
  assert.deepEqual(await createNoteFile(dir, 'Churn by region!'), { ok: true, name: '002-churn-by-region-2.md' })
  assert.deepEqual(await createNoteFile(dir, 'Churn by region?'), { ok: true, name: '003-churn-by-region-3.md' })
  assert.equal(await readFile(join(dir, 'notes', '001-churn-by-region.md'), 'utf8'), '# Churn by Region\n\n')
  assert.equal((await createNoteFile(dir, '   ')).ok, false)
})

test('the next number follows the highest one, and other files are ignored', async () => {
  const dir = await folder()
  await mkdir(join(dir, 'notes'))
  await writeFile(join(dir, 'notes', '007-a.md'), '# A\n')
  await writeFile(join(dir, 'notes', 'scratch.md'), 'x')
  assert.deepEqual(await createNoteFile(dir, 'B'), { ok: true, name: '008-b.md' })
  assert.deepEqual((await readNoteFiles(dir)).map(n => n.name), ['007-a.md', '008-b.md'])
})

test('save writes only when the file still holds the expected text', async () => {
  const dir = await folder()
  await createNoteFile(dir, 'A')
  assert.deepEqual(await saveNoteFile(dir, '001-a.md', '# A\n\n', '# A\n\nbody [q 1]\n'), { ok: true })
  const stale = await saveNoteFile(dir, '001-a.md', '# A\n\n', 'other')
  assert.deepEqual(stale, { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' })
  assert.equal(await readFile(join(dir, 'notes', '001-a.md'), 'utf8'), '# A\n\nbody [q 1]\n')
  assert.deepEqual((await readNoteFiles(dir))[0]?.citations, [1])
})

test('names outside notes/ or not matching the pattern are refused', async () => {
  const dir = await folder()
  await writeFile(join(dir, 'notes.md'), 'x')
  for (const name of ['../notes.md', '../../x', 'notes.md', '001-a.md/../../x', '/etc/passwd', '']) {
    assert.equal((await saveNoteFile(dir, name, '', 'x')).ok, false, name)
    assert.equal((await deleteNoteFile(dir, name, '')).ok, false, name)
    assert.equal((await readNoteFileByName(dir, name)).ok, false, name)
  }
})

test('delete removes the file only when it still holds the expected text', async () => {
  const dir = await folder()
  await createNoteFile(dir, 'A')
  assert.equal((await deleteNoteFile(dir, '001-a.md', 'changed')).ok, false)
  assert.deepEqual(await deleteNoteFile(dir, '001-a.md', '# A\n\n'), { ok: true })
  assert.deepEqual(await readdir(join(dir, 'notes')), [])
  assert.equal((await deleteNoteFile(dir, '001-a.md', '# A\n\n')).ok, false)
})

test('loadState lists note files, and sees a change made in place', async () => {
  const dir = await folder()
  await createNoteFile(dir, 'A')
  const first = await loadState({ name: 'x', path: dir })
  assert.equal(first.noteFiles[0]?.title, 'A')
  await writeFile(join(dir, 'notes', '001-a.md'), '# Renamed [[b]]\n')
  assert.deepEqual((await loadState({ name: 'x', path: dir })).noteFiles[0]?.links, ['b'])
})

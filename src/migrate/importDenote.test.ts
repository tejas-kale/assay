import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { byCodeUnit } from '../core/nameOrder.ts'
import { applyImport, convertDenote, parseField, planImport } from './importDenote.ts'

const FINDING = `---
title: "PS-8420 removes \\"dynamic\\" models from vw_panel"
date: 2026-10-06T10:01:00
tags: [finding, tables, datamart]
identifier: "20261006T100001"
author: "Claude (directed by Tejas Kale)"
as_of: "2026-10-01"
status: "unverified"
---

Drops a column from [[20261006T090118|vw_panel]].

# Sources

- [SQL](https://example.com/x.sql)
\`\`\`
# not a heading
\`\`\`
`

test('a denote note becomes a root note: title line, one metadata line, headings one level down', () => {
  const note = convertDenote('20261006T100001--ps-8420__finding_tables_datamart.md', FINDING)
  assert.ok(note.ok)
  assert.equal(note.id, '20261006T100001')
  assert.equal(note.file, '20261006T100001-ps-8420-removes-dynamic-models-from-vw-panel.md')
  assert.equal(
    note.text,
    [
      '# PS-8420 removes "dynamic" models from vw_panel',
      '',
      'Tags: finding, tables, datamart · Status: unverified · As of: 2026-10-01',
      '',
      'Drops a column from [[20261006T090118|vw_panel]].',
      '',
      '## Sources',
      '',
      '- [SQL](https://example.com/x.sql)',
      '```',
      '# not a heading',
      '```',
      '',
    ].join('\n'),
  )
})

test('recaps and sources are skipped, and a note without front matter is refused', () => {
  const recap = FINDING.replace('tags: [finding, tables, datamart]', 'tags: [recap]')
  assert.deepEqual(convertDenote('20261006T100001--x__recap.md', recap), { ok: false, reason: 'skipped: recap' })
  assert.deepEqual(convertDenote('20261006T100001--x__source.md', FINDING.replace('datamart]', 'source]')), { ok: false, reason: 'skipped: source' })
  assert.deepEqual(convertDenote('x.md', 'no front matter'), { ok: false, reason: 'no front matter' })
})

test('import writes new notes only, never over an existing ID, and reports links to notes not imported', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'assay-denote-'))
  const from = join(scratch, 'claude')
  const root = join(scratch, 'root')
  await mkdir(from)
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(from, '20261006T100001--a__finding.md'), FINDING)
  await writeFile(join(from, '20261006T100002--b__recap.md'), FINDING.replace('20261006T100001', '20261006T100002').replace('finding, tables, datamart', 'recap'))
  await writeFile(join(from, '20261006T100003--c__concept.md'), FINDING.replace('20261006T100001', '20261006T100003'))
  await writeFile(join(root, 'notes', '20261006T100003-already.md'), '# Already\n')
  await writeFile(join(from, 'README.txt'), 'not a note')

  const plan = await planImport(from, root)
  assert.deepEqual(plan.notes.map(note => note.file), ['20261006T100001-ps-8420-removes-dynamic-models-from-vw-panel.md'])
  assert.deepEqual(plan.skipped, [
    { from: '20261006T100002--b__recap.md', reason: 'skipped: recap' },
    { from: '20261006T100003--c__concept.md', reason: 'ID already in notes/' },
  ])
  assert.deepEqual(plan.unresolved, ['20261006T090118'])

  await applyImport(root, plan)
  assert.deepEqual((await readdir(join(root, 'notes'))).sort(byCodeUnit), ['20261006T100001-ps-8420-removes-dynamic-models-from-vw-panel.md', '20261006T100003-already.md'])
  assert.equal(await readFile(join(root, 'notes', '20261006T100003-already.md'), 'utf8'), '# Already\n')
  // A rerun finds nothing new.
  assert.equal((await planImport(from, root)).notes.length, 0)
})

test('a front matter field is a lower-case key, a colon, and the value after any white space', () => {
  assert.deepEqual(parseField('title: A "b"'), { key: 'title', value: 'A "b"' })
  assert.deepEqual(parseField('as_of:2026-10-06'), { key: 'as_of', value: '2026-10-06' })
  assert.deepEqual(parseField('status:  \t spaced  '), { key: 'status', value: 'spaced  ' })
  assert.deepEqual(parseField('tags:'), { key: 'tags', value: '' })
  // White space that is a line break counts as the gap, so an empty value with a carriage return still has a key.
  assert.deepEqual(parseField('tags:\r'), { key: 'tags', value: '' })
  assert.deepEqual(parseField('a:  b'), { key: 'a', value: 'b' })
  // A line break after the value, or a key that is not lower case, is not a field.
  assert.equal(parseField('title: x\r'), undefined)
  assert.equal(parseField('title: x y'), undefined)
  assert.equal(parseField('Title: x'), undefined)
  assert.equal(parseField(': x'), undefined)
  assert.equal(parseField('  title: x'), undefined)
})

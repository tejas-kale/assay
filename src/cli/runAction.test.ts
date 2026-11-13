import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'

import { expect } from '../testing/expect.ts'
import { runNode } from '../testing/bundle.ts'

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'assay-action-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'queries'))
  await writeFile(join(dir, 'queries/007_sites.sql'), '-- author: claude\n-- postgres\nSELECT 7\n')
  return dir
}

test('rerunning a saved query sends its body, engine and origin through the request protocol', async t => {
  const dir = await fixture(t)
  const ran = await runNode(resolve('src/cli/runAction.ts'), JSON.stringify({ action: 'rerun', file: '007_sites.sql' }), { ...process.env, ASSAY_ANALYSIS: dir })
  expect(ran.code).toBe(0)
  const result = JSON.parse(ran.stdout) as { ok: boolean; id: string }
  expect(result.ok).toBe(true)
  expect(JSON.parse(await readFile(join(dir, `.assay/requests/${result.id}.json`), 'utf8'))).toEqual({ id: result.id, kind: 'sql', sql: 'SELECT 7\n', engine: 'postgres', from: 7 })
  expect(await readdir(join(dir, '.assay/requests'))).toEqual([`${result.id}.json`])
  expect(await readFile(join(dir, 'queries/007_sites.sql'), 'utf8')).toContain('-- author: claude')
})

test('saving changed Python code sends a new user request without changing its source', async t => {
  const dir = await fixture(t)
  await writeFile(join(dir, 'queries/008_total.py'), '# author: claude\nprint(7)\n')
  const editor = join(dir, 'editor with spaces.sh')
  await writeFile(editor, '#!/bin/sh\nprintf "print(8)\\n" > "$1"\n')
  const ran = await runNode(resolve('src/cli/runAction.ts'), JSON.stringify({ action: 'edit', file: '008_total.py' }), { ...process.env, ASSAY_ANALYSIS: dir, EDITOR: `/bin/sh '${editor}'` })
  const result = JSON.parse(ran.stdout) as { ok: boolean; id: string }
  expect(result.ok).toBe(true)
  expect(JSON.parse(await readFile(join(dir, `.assay/requests/${result.id}.json`), 'utf8'))).toEqual({ id: result.id, kind: 'python', code: 'print(8)\n', from: 8 })
  expect(await readFile(join(dir, 'queries/008_total.py'), 'utf8')).toBe('# author: claude\nprint(7)\n')
})

test('closing an editor without changes or with a failed exit sends nothing', async t => {
  const dir = await fixture(t)
  for (const [editor, expected] of [['/usr/bin/true', { ok: true, unchanged: true }], ['/usr/bin/false', { ok: false, message: 'The editor failed; no run was sent.' }]] as const) {
    const ran = await runNode(resolve('src/cli/runAction.ts'), JSON.stringify({ action: 'edit', file: '007_sites.sql' }), { ...process.env, ASSAY_ANALYSIS: dir, EDITOR: editor })
    expect(JSON.parse(ran.stdout)).toEqual(expected)
  }
  expect(await readdir(dir)).toEqual(['queries'])
})


test('refuses traversal, linked run files and linked request folders without writing through them', async t => {
  const dir = await fixture(t)
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.sql'), 'SELECT secret\n')
  await symlink(join(outside, 'secret.sql'), join(dir, 'queries/009_link.sql'))
  for (const file of ['../outside/secret.sql', '009_link.sql', 'not-a-run.sql']) {
    const ran = await runNode(resolve('src/cli/runAction.ts'), JSON.stringify({ action: 'rerun', file }), { ...process.env, ASSAY_ANALYSIS: dir })
    expect((JSON.parse(ran.stdout) as { ok: boolean }).ok).toBe(false)
  }
  await mkdir(join(dir, '.assay'))
  await symlink(outside, join(dir, '.assay/requests'))
  const ran = await runNode(resolve('src/cli/runAction.ts'), JSON.stringify({ action: 'rerun', file: '007_sites.sql' }), { ...process.env, ASSAY_ANALYSIS: dir })
  expect((JSON.parse(ran.stdout) as { message: string }).message).toContain('not a real folder')
  expect(await readdir(outside)).toEqual(['secret.sql'])
})


test('an interactive editor gets the controlling terminal while action JSON stays on captured stdout', { skip: process.platform !== 'linux' }, async t => {
  const dir = await fixture(t)
  const editor = join(dir, 'terminal-editor.sh')
  await writeFile(editor, '#!/bin/sh\ntest -t 0 && test -t 1 && test -t 2 || exit 3\nprintf "SELECT 8\\n" > "$1"\n')
  const input = join(dir, 'input.json')
  await writeFile(input, JSON.stringify({ action: 'edit', file: '007_sites.sql' }))
  const { stdout } = await promisify(execFile)('/usr/bin/script', ['-q', '-e', '-c', 'exec "$ACTION_NODE" "$ACTION_SOURCE" < "$ACTION_INPUT"', '/dev/null'], {
    env: { ...process.env, ASSAY_ANALYSIS: dir, EDITOR: `/bin/sh '${editor}'`, ACTION_NODE: process.execPath, ACTION_SOURCE: resolve('src/cli/runAction.ts'), ACTION_INPUT: input },
  })
  const result = JSON.parse(stdout) as { ok: boolean; id: string }
  expect(result.ok).toBe(true)
  expect(JSON.parse(await readFile(join(dir, `.assay/requests/${result.id}.json`), 'utf8'))).toMatchObject({ sql: 'SELECT 8\n', from: 7 })
})

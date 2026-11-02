import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { currentCommit } from './trustedCommit.ts'

test('the commit is the last one that changed the calculation file, 12 digits; undefined without the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assay-root-'))
  const sh = (...args: string[]) => execFileSync('git', ['-C', join(root, 'trusted'), ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim()
  await mkdir(join(root, 'trusted'))
  sh('init', '-q')
  await writeFile(join(root, 'trusted', 'churn.sql'), 'select 1\n')
  sh('add', '.')
  sh('commit', '-q', '-m', 'x')
  assert.equal(await currentCommit(root, 'churn'), sh('rev-parse', 'HEAD').slice(0, 12))
  assert.equal(await currentCommit(root, 'nothing'), undefined)
})

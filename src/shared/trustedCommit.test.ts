import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { currentCommit } from './trustedCommit.ts'

test('the commit is the last one that changed the calculation file, 12 digits; undefined without the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assay-root-'))
  const run = promisify(execFile)
  const sh = async (...args: string[]) => (await run('git', ['-C', join(root, 'trusted'), ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })).stdout.trim()
  await mkdir(join(root, 'trusted'))
  await sh('init', '-q')
  await writeFile(join(root, 'trusted', 'churn.sql'), 'select 1\n')
  await sh('add', '.')
  await sh('commit', '-q', '-m', 'x')
  assert.equal(await currentCommit(root, 'churn'), (await sh('rev-parse', 'HEAD')).slice(0, 12))
  assert.equal(await currentCommit(root, 'nothing'), undefined)
})

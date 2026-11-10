import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nextVersion, notesFromGit, versionFromGit } from './next-version.ts'

test('no tag yet: the first release is 0.1.0', () => {
  assert.equal(nextVersion(null, ['major']), '0.1.0')
})

test('no Release trailer bumps the patch', () => {
  assert.equal(nextVersion('v0.4.2', []), '0.4.3')
})

test('a minor trailer bumps the minor and resets the patch', () => {
  assert.equal(nextVersion('v0.4.2', ['minor']), '0.5.0')
})

test('a major trailer wins over a minor one, in any case', () => {
  assert.equal(nextVersion('v0.4.2', ['minor', 'Major', 'minor']), '1.0.0')
})

test('an unknown trailer value is a patch', () => {
  assert.equal(nextVersion('v0.4.2', ['huge']), '0.4.3')
})

function scratchRepo(): { dir: string; commit: (message: string) => void; tag: (name: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'next-version-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  return {
    dir,
    commit: (message) => git('commit', '-q', '--allow-empty', '-m', message),
    tag: (name) => git('tag', name),
  }
}

test('from git: a trailer before the last tag is ignored', () => {
  const repo = scratchRepo()
  repo.commit('Big change\n\nRelease: major')
  repo.tag('v1.2.3')
  repo.commit('Small fix')
  assert.equal(versionFromGit(repo.dir), '1.2.4')
})

test('from git: no v* tag gives the first version; a trailer after the tag counts', () => {
  const repo = scratchRepo()
  repo.commit('Start')
  repo.tag('not-a-release')
  assert.equal(versionFromGit(repo.dir), '0.1.0')
  repo.tag('v0.1.0')
  repo.commit('New tab\n\nRelease: minor')
  assert.equal(versionFromGit(repo.dir), '0.2.0')
})

test('from git: the release notes are the subjects since the last tag, newest first', () => {
  const repo = scratchRepo()
  repo.commit('Old feature')
  repo.tag('v0.1.0')
  repo.commit('Search finds notes\n\nLong body.')
  repo.commit('The strip moves left\n\nRelease: minor')
  assert.equal(notesFromGit(repo.dir), '- The strip moves left\n- Search finds notes\n')
})

test('from git: a subject that reads like a trailer is not one', () => {
  const repo = scratchRepo()
  repo.commit('Start')
  repo.tag('v0.4.2')
  repo.commit('Release: minor is now documented')
  assert.equal(versionFromGit(repo.dir), '0.4.3')
})

test('from git: a "Release: major" line in the body, with prose after it, is not a trailer', () => {
  const repo = scratchRepo()
  repo.commit('Start')
  repo.tag('v0.4.2')
  repo.commit('Document trailers\n\nWrite it like this:\n\nRelease: major\n\nand CI bumps the major.')
  assert.equal(versionFromGit(repo.dir), '0.4.3')
})

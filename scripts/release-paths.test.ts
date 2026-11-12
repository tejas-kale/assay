import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shouldRelease } from './release-paths.ts'

test('a push that changes only docs, tests and CI does not release', () => {
  const paths = [
    'specs/slices/slice-11.md',
    'README.md',
    'src/core/keymap.test.ts',
    'scripts/next-version.test.ts',
    'python/tests/test_analysis_sql.py',
    'tests/integration/app.test.ts',
    '.github/workflows/ci.yml',
  ]
  assert.equal(shouldRelease(paths), false)
})

test('one source file among them releases', () => {
  assert.equal(shouldRelease(['specs/slices/slice-11.md', 'src/core/keymap.ts']), true)
})

test('python code, the lockfiles and the config release; a test helper outside tests/ does too', () => {
  for (const path of ['python/analysis_sql.py', 'package-lock.json', 'python/uv.lock', 'src/testing/expect.ts']) {
    assert.equal(shouldRelease([path]), true, path)
  }
})

test("the plugin's Markdown ships in the app, so a skill change releases", () => {
  assert.equal(shouldRelease(['plugin/skills/resume/SKILL.md']), true)
})

test('an empty diff releases: the push could not be compared (a new branch, a force push)', () => {
  assert.equal(shouldRelease([]), true)
})

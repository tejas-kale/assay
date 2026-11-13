// The CI workflow's security properties (docs/developer/security.md), read from its text: the release job alone
// reaches the signing secrets, through the main-only environment, with no token left in git and no install scripts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

/** Each job's text, by name: the lines from `  <name>:` up to the next job. */
function jobs(): Map<string, string> {
  const body = workflow.slice(workflow.indexOf('\njobs:\n') + 7)
  const found = new Map<string, string>()
  for (const part of body.split(/\n(?= {2}[a-z][\w-]*:\n)/)) {
    const name = /^ {2}([a-z][\w-]*):/.exec(part)?.[1]
    if (name) found.set(name, part)
  }
  return found
}

const release = jobs().get('release') ?? ''

test('the workflow has its three jobs', () => {
  assert.deepEqual([...jobs().keys()], ['unit', 'integration', 'release'])
})

test('only the release job names a secret, and it runs in the release environment on pushes to main (audit UP-2)', () => {
  for (const [name, text] of jobs()) if (name !== 'release') assert.doesNotMatch(text, /secrets\./, name)
  assert.match(release, /\n {4}environment: release\n/)
  assert.match(release, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/)
  assert.doesNotMatch(workflow, /pull_request_target/)
})

test('the release checkout keeps no token, and no dependency install script runs there (audit UP-3, DEP-3)', () => {
  assert.match(release, /persist-credentials: false/)
  assert.match(release, /npm ci --ignore-scripts/)
  assert.doesNotMatch(release, /run: npm ci\n/)
})

test('the release checks the built app fuses, and the unit job audits both lockfiles (audit UP-4, DEP-1)', () => {
  assert.match(release, /node scripts\/fuse-check\.ts dist\/mac-arm64\/Assay\.app/)
  const unit = jobs().get('unit') ?? ''
  assert.match(unit, /npm audit --audit-level=high/)
  assert.match(unit, /pip-audit@[\d.]+ .*--require-hashes/)
})

test('every action is pinned by commit, and uv by version (audit DEP-7)', () => {
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1] ?? '')
  assert.ok(uses.length > 0)
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/, action)
  assert.equal([...workflow.matchAll(/setup-uv@\S+ # \S+\n {8}with:\n {10}version: \d+\.\d+\.\d+\n/g)].length, workflow.split('setup-uv@').length - 1)
})

test('mod checks install and audit only the locked native runner without install scripts', () => {
  const unit = jobs().get('unit') ?? ''
  assert.match(unit, /npm ci --prefix scripts\/mod-runner --ignore-scripts/)
  assert.match(unit, /npm audit --prefix scripts\/mod-runner --audit-level=high/)
  assert.doesNotMatch(unit, /npm install/)
  const lock = JSON.parse(readFileSync(new URL('mod-runner/package-lock.json', import.meta.url), 'utf8')) as {
    lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string }>
  }
  assert.equal(lock.lockfileVersion, 3)
  assert.equal(Object.keys(lock.packages).length, 2)
  const runner = lock.packages['node_modules/@anthropic-ai/claude-code-linux-x64']
  assert.equal(runner?.version, '2.1.323')
  assert.equal(runner.resolved, 'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.323.tgz')
  assert.match(runner.integrity ?? '', /^sha512-[A-Za-z0-9+/]+=*$/)
})

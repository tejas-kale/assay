import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cliVerb, helpText, USAGE } from './cliHelp.ts'

test('the help names every command, the matching rules, the environment and the root in use', () => {
  const help = helpText({ version: '1.2.3', root: '/work/root' })
  for (const part of ['assay 1.2.3', 'assay open [name]', 'assay new <title>', 'assay root [path]', 'assay vd [run] [name]', 'uv tool install visidata', 'assay --version', '"Quarantine Checks"',
    'Esc cancels', 'searched fuzzily', 'creates a new analysis', 'about a minute', 'ASSAY_CLAUDE_BIN', 'ASSAY_THEME', 'Root: /work/root', 'Node 22.15', 'uv']) {
    assert.ok(help.includes(part), part)
  }
  assert.match(helpText({ version: '1.2.3' }), /Root: not set: run assay root <path>, or choose one in the app's Settings/)
  assert.ok(help.split('\n').every(line => line.length <= 100))
})

test('help and version flags win anywhere; anything else is a command or a usage error', () => {
  for (const args of [[], ['help'], ['--help'], ['-h'], ['open', '--help'], ['new', 'x', '-h']]) assert.equal(cliVerb(args), 'help', args.join(' '))
  for (const args of [['--version'], ['-v'], ['version']]) assert.equal(cliVerb(args), 'version')
  assert.equal(cliVerb(['open']), 'open')
  assert.equal(cliVerb(['open', 'a', 'b']), 'usage')
  assert.equal(cliVerb(['new']), 'usage')
  assert.equal(cliVerb(['new', 'Panel', 'churn']), 'new')
  assert.equal(cliVerb(['root']), 'root')
  assert.equal(cliVerb(['root', '/work/root']), 'root')
  assert.equal(cliVerb(['root', 'a', 'b']), 'usage')
  assert.equal(cliVerb(['vd']), 'vd')
  assert.equal(cliVerb(['vd', '12', 'churn']), 'vd')
  assert.equal(cliVerb(['vd', 'a', 'b', 'c']), 'usage')
  assert.equal(cliVerb(['list']), 'usage')
  assert.match(USAGE, /assay --help/)
})

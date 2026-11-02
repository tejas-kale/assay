// The plugin's hooks, run as the bundled scripts Claude Code runs: each gets its JSON on stdin. Ported from the
// analysis mod's tests of its prompt, Bash and write guards (tools.test.ts, dictionary.test.ts, trust.test.tsx,
// python-requests.test.ts).
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BASH_PYTHON_DENY } from '../core/bashGuard.ts'
import { bundle, runNode } from '../testing/bundle.ts'
import { expect } from '../testing/expect.ts'

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'assay-hooks-'))
  const root = join(dir, 'notes-src')
  const analysis = join(root, 'analyses/panel')
  await mkdir(join(analysis, '.assay'), { recursive: true })
  return { dir, root, analysis, env: { PATH: process.env.PATH, ASSAY_ANALYSIS: analysis, ASSAY_ROOT: root, ASSAY_VENV: join(dir, 'venv') } }
}

async function hook(name: string, input: object, env: Record<string, string | undefined>) {
  const ran = await runNode(join(await bundle(), 'hooks', `${name}.mjs`), JSON.stringify(input), env)
  expect([name, ran.code, ran.stderr]).toEqual([name, 0, ''])
  return ran.stdout.trim() ? (JSON.parse(ran.stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput : undefined
}

const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })

test('Bash calls that run Python are refused, pointing to the python tool; pytest and package commands pass', async () => {
  const { env } = await scratch()
  for (const command of ['python x.py', 'python3 -c "print(1)"', 'uv run python x.py', 'cat x.py | python']) {
    expect([command, await hook('bash', bash(command), env)]).toEqual([command, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: BASH_PYTHON_DENY }])
  }
  for (const command of ['python -m pytest tests', 'pytest', 'claude-pkg uv add pandas', 'uv sync', 'python --version', 'ls']) {
    expect([command, await hook('bash', bash(command), env)]).toEqual([command, undefined])
  }
  expect(BASH_PYTHON_DENY).toContain('mcp__plugin_assay_assay__python')
})

test('outside an Assay session Bash is not guarded', async () => {
  expect(await hook('bash', bash('python x.py'), { PATH: process.env.PATH })).toBeUndefined()
})

test("writes into the shared dictionaries/ and trusted/ are refused; drafts in lib/ are not", async () => {
  const { root, analysis, env } = await scratch()
  const write = (tool: string, input: object) => hook('write', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: analysis }, env)
  for (const path of [`${root}/dictionaries/main.panel.sites.yaml`, `${analysis}/../../trusted/x.sql`, '../../trusted/y.py']) {
    const said = await write('Write', { file_path: path, content: 'x' })
    expect(said?.permissionDecision).toBe('deny')
    expect(said?.permissionDecisionReason).toMatch(/change only through the user's approval/)
    expect(said?.permissionDecisionReason).toContain('the Trust tab in Assay')
  }
  expect((await write('Edit', { file_path: `${root}/trusted/x.sql`, old_string: 'a', new_string: 'b' }))?.permissionDecision).toBe('deny')
  expect((await write('NotebookEdit', { notebook_path: `${root}/trusted/x.ipynb` }))?.permissionDecision).toBe('deny')
  expect(await write('Write', { file_path: `${analysis}/lib/dictionaries/main.panel.sites.yaml`, content: 'x' })).toBeUndefined()
  expect(await write('Write', { file_path: `${root}/trusted-old/x`, content: 'x' })).toBeUndefined()
  expect(await hook('write', { tool_name: 'Write', tool_input: { file_path: `${root}/trusted/x.sql` } }, { PATH: process.env.PATH })).toBeUndefined()
})

test("each prompt carries the rules, the trust rules and the kernel's python", async () => {
  const { root, analysis, env } = await scratch()
  await writeFile(join(analysis, '.assay/session.json'), JSON.stringify({ python: '/w/.venv/bin/python' }))
  const said = await hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'why? and how?' }, env)
  expect(said?.hookEventName).toBe('UserPromptSubmit')
  const rules = said?.additionalContext ?? ''
  for (const part of ['one concept per reply', 'mcp__plugin_assay_assay__focus', 'mcp__plugin_assay_assay__order', 'mcp__plugin_assay_assay__python', 'q(N)', 'matplotlib', '.head()', 'lib/<name>.py', '/w/.venv/bin/python -m pytest tests', 'claude-pkg venv-assay'])
    expect(rules).toContain(part)
  expect(rules).toContain(`${root}/dictionaries`)
  expect(rules).toContain('lib/dictionaries/<catalog.schema.table>.yaml')
  expect(rules).toContain('Only the user promotes it, in the Trust tab in Assay.')
  expect(rules).not.toContain('/an')
  expect(rules).not.toContain('Since your last turn')
})

test("without a kernel the rules name venv-assay's python when it is built, else plain python", async () => {
  const { dir, env } = await scratch()
  expect((await hook('prompt', { prompt: 'x' }, env))?.additionalContext).toContain('\nRun the tests from the analysis folder, with the kernel\'s python: python -m pytest tests')
  await mkdir(join(dir, 'venv/bin'), { recursive: true })
  await writeFile(join(dir, 'venv/bin/python'), '')
  expect((await hook('prompt', { prompt: 'x' }, env))?.additionalContext).toContain(`${dir}/venv/bin/python -m pytest tests`)
})

test('the rules list the usable trusted calculations the helper lists', async () => {
  const { dir, env } = await scratch()
  await mkdir(join(dir, 'venv/bin'), { recursive: true })
  const list = { calculations: [{ name: 'completes_by_site', kind: 'sql', file: 'c.sql', description: 'Completes per site.', parameters: [{ name: 'start', type: 'date', required: true }], commit: 'abc', dirty: false }, { name: 'top_sites', kind: 'python', file: 't.py', description: 'Top.', parameters: [], commit: '', dirty: true }], problems: [] }
  // A stand-in for venv-assay's python: `-m analysis_trust list <root>` prints the list.
  await writeFile(join(dir, 'venv/bin/python'), `#!/bin/sh\n[ "$3" = list ] && echo '${JSON.stringify(list)}'\n`, { mode: 0o755 })
  const rules = (await hook('prompt', { prompt: 'x' }, env))?.additionalContext ?? ''
  expect(rules).toContain('run the one that fits with mcp__plugin_assay_assay__trusted. If you write your own SQL where one fits, say why in one line.')
  expect(rules).toContain('- completes_by_site(start: date): Completes per site.')
  expect(rules).not.toContain('top_sites')
})

test("the run notice lists the user's runs the server recorded since the last prompt, once", async () => {
  const { analysis, env } = await scratch()
  const runs = [{ number: 3, language: 'python', from: 1 }, { number: 5, language: 'sql' }, { number: 6, language: 'python', replay: 3 }]
  await writeFile(join(analysis, '.assay/user-runs.json'), JSON.stringify(runs))
  expect((await hook('prompt', { prompt: 'go' }, env))?.additionalContext).toContain(
    'Since your last turn the user ran: 003 python (from 001), 005 sql, 006 python (replay of 003). Their Python ran in your kernel, so its variables may have changed; read queries/<file> when it matters.',
  )
  expect(await readFile(join(analysis, '.assay/user-runs.json'), 'utf8').catch(() => undefined)).toBeUndefined()
  expect((await hook('prompt', { prompt: 'go' }, env))?.additionalContext).not.toContain('Since your last turn')
  await writeFile(join(analysis, '.assay/user-runs.json'), JSON.stringify([{ number: 7, language: 'sql' }]))
  expect((await hook('prompt', { prompt: 'go' }, env))?.additionalContext).toContain('Since your last turn the user ran: 007 sql. Read queries/<file> when it matters.')
})

test('outside an Assay session a prompt carries no rule', async () => {
  expect(await hook('prompt', { prompt: 'hi' }, { PATH: process.env.PATH })).toBeUndefined()
})

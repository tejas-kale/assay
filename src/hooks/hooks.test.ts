// The plugin's hooks, run as the bundled scripts Claude Code runs: each gets its JSON on stdin. Ported from the
// analysis mod's tests of its prompt, Bash and write guards (tools.test.ts, dictionary.test.ts, trust.test.tsx,
// python-requests.test.ts).
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
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
  await writeFile(join(analysis, 'analysis.yaml'), 'title: Panel sites\ncreated: 2026-11-02\n')
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
  expect(BASH_PYTHON_DENY).toContain('mcp__assay__python')
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
  for (const part of ['one concept per reply', 'mcp__assay__focus', 'mcp__assay__order', 'mcp__assay__python', 'q(N)', 'matplotlib', '.head()', 'lib/<name>.py', 'cd analyses/panel && /w/.venv/bin/python -m pytest tests', "Assay's venv is the only Python"])
    expect(rules).toContain(part)
  expect(rules).toContain(`${root}/dictionaries`)
  expect(rules).not.toContain('/an')
  expect(rules).not.toContain('Since your last turn')
})

test('each prompt names the open analysis: its title, its folder from the root, and what lives there', async () => {
  const { env } = await scratch()
  const rules = (await hook('prompt', { prompt: 'x' }, env))?.additionalContext ?? ''
  expect(rules).toContain('Open analysis: titled under [analysis title], in analyses/panel/.')
  expect(rules).toContain('[analysis title]\nPanel sites\n</assay-data>')
  expect(rules).toContain('analyses/panel/lib/, analyses/panel/tests/, analyses/panel/lib/trusted/ and analyses/panel/lib/dictionaries/')
  expect(rules).toContain('You work from the root: give paths from it.')
})

test('an analysis without a title in analysis.yaml is named by its folder', async () => {
  const { analysis, env } = await scratch()
  await writeFile(join(analysis, 'analysis.yaml'), 'created: 2026-11-02\n')
  expect((await hook('prompt', { prompt: 'x' }, env))?.additionalContext).toContain('[analysis title]\npanel\n</assay-data>')
})

test("without a kernel the rules name venv-assay's python when it is built, else plain python", async () => {
  const { dir, env } = await scratch()
  expect((await hook('prompt', { prompt: 'x' }, env))?.additionalContext).toContain('\nRun the tests from the analysis folder: cd analyses/panel && python -m pytest tests')
  await mkdir(join(dir, 'venv/bin'), { recursive: true })
  await writeFile(join(dir, 'venv/bin/python'), '')
  expect((await hook('prompt', { prompt: 'x' }, env))?.additionalContext).toContain(`cd analyses/panel && ${dir}/venv/bin/python -m pytest tests`)
})

test('the rules list the usable trusted calculations the helper lists', async () => {
  const { dir, env } = await scratch()
  await mkdir(join(dir, 'venv/bin'), { recursive: true })
  const list = { calculations: [{ name: 'completes_by_site', kind: 'sql', file: 'c.sql', description: 'Completes per site.', parameters: [{ name: 'start', type: 'date', required: true }], commit: 'abc', dirty: false }, { name: 'top_sites', kind: 'python', file: 't.py', description: 'Top.', parameters: [], commit: '', dirty: true }], problems: [] }
  // A stand-in for venv-assay's python: `-I -B -m analysis_trust list <root>` prints the list.
  await writeFile(join(dir, 'venv/bin/python'), `#!/bin/sh\n[ "$5" = list ] && echo '${JSON.stringify(list)}'\n`, { mode: 0o755 })
  const rules = (await hook('prompt', { prompt: 'x' }, env))?.additionalContext ?? ''
  expect(rules).toContain('answer one question whole: run one with mcp__assay__trusted when it is exactly the question')
  expect(rules).toContain('- completes_by_site(start: date): Completes per site.')
  expect(rules).not.toContain('top_sites')
})

test("the helper that lists the trusted calculations inherits ASSAY_LEDGER, so the hook lists only what the ledger approves (PI-2)", async () => {
  const { dir, env } = await scratch()
  await mkdir(join(dir, 'venv/bin'), { recursive: true })
  // A stand-in for the helper: it calls the calculation trusted only when it sees the ledger's path, as analysis_ledger does.
  const calc = (dirty: string) => `{"calculations":[{"name":"by_site","kind":"sql","file":"c.sql","description":"Per site.","parameters":[],"commit":"abc","dirty":${dirty}}],"problems":[]}`
  const script = `#!/bin/sh\nif [ "$ASSAY_LEDGER" = "${join(dir, 'ledger.json')}" ]; then echo '${calc('false')}'; else echo '${calc('true')}'; fi\n`
  await writeFile(join(dir, 'venv/bin/python'), script, { mode: 0o755 })
  expect((await hook('prompt', { prompt: 'x' }, env))?.additionalContext ?? '').not.toContain('by_site')
  expect((await hook('prompt', { prompt: 'x' }, { ...env, ASSAY_LEDGER: join(dir, 'ledger.json') }))?.additionalContext ?? '').toContain('- by_site(): Per site.')
})

test('the rules point once at the propose-trusted skill, and no longer carry the drafting rules', async () => {
  const { env } = await scratch()
  const rules = (await hook('prompt', { prompt: 'x' }, env))?.additionalContext ?? ''
  const pointer = 'Propose a trusted block, calculation or dictionary entry with the assay:propose-trusted skill; only the user promotes it, in the Trust tab in Assay.'
  expect(rules.split(pointer).length).toBe(2)
  expect(rules).not.toContain('Propose a new trusted calculation')
  expect(rules).not.toContain('Draft dictionary entries')
  expect(rules).not.toContain('lib/dictionaries/<catalog')
  expect(rules).toContain('never write there')
})

test("the run notice lists the user's runs the server recorded since the last prompt, once", async () => {
  const { analysis, env } = await scratch()
  const runs = [{ number: 3, language: 'python', from: 1 }, { number: 5, language: 'sql' }, { number: 6, language: 'python', replay: 3 }]
  await writeFile(join(analysis, '.assay/user-runs.json'), JSON.stringify(runs))
  expect((await hook('prompt', { prompt: 'go' }, env))?.additionalContext).toContain(
    'Since your last turn the user ran: 003 python (from 001), 005 sql, 006 python (replay of 003). Their Python ran in your kernel, so its variables may have changed; read analyses/panel/queries/<file> when it matters.',
  )
  expect(await readFile(join(analysis, '.assay/user-runs.json'), 'utf8').catch(() => undefined)).toBeUndefined()
  expect((await hook('prompt', { prompt: 'go' }, env))?.additionalContext).not.toContain('Since your last turn')
  await writeFile(join(analysis, '.assay/user-runs.json'), JSON.stringify([{ number: 7, language: 'sql' }]))
  expect((await hook('prompt', { prompt: 'go' }, env))?.additionalContext).toContain('Since your last turn the user ran: 007 sql. Read analyses/panel/queries/<file> when it matters.')
})

test('the notice carries the step check lines the server recorded, once', async () => {
  const { analysis, env } = await scratch()
  await writeFile(join(analysis, '.assay/step-notices.json'), JSON.stringify(['q042 step spend: grain customer_id has 3 duplicate rows.', 7]))
  const said = (await hook('prompt', { prompt: 'go' }, env))?.additionalContext
  expect(said).toContain('[step checks failed since your last turn]\n- q042 step spend: grain customer_id has 3 duplicate rows.')
  expect(said).not.toContain('- 7')
  expect(await readFile(join(analysis, '.assay/step-notices.json'), 'utf8').catch(() => undefined)).toBeUndefined()
  expect((await hook('prompt', { prompt: 'go' }, env))?.additionalContext).not.toContain('step checks failed')
})

test('a Write or Edit into another analysis is refused, naming the open one; the open one is allowed', async () => {
  const { root, analysis, env } = await scratch()
  const write = (tool: string, input: object) => hook('write', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: root }, env)
  const reason = (other: string) => `${other} is not the open analysis. The open analysis is in analyses/panel/: write only there.`
  const cases: [string, string][] = [
    [`${root}/analyses/other/lib/x.py`, 'analyses/other'],
    ['analyses/other/notes.md', 'analyses/other'],
    [`${analysis}/../other/x.py`, 'analyses/other'],
    [`${root}/analyses/newone/analysis.yaml`, 'analyses/newone'],
  ]
  for (const [path, other] of cases) {
    const said = await write('Write', { file_path: path, content: 'x' })
    expect([path, said?.permissionDecision, said?.permissionDecisionReason]).toEqual([path, 'deny', reason(other)])
  }
  expect((await write('Edit', { file_path: `${root}/analyses/other/x.py`, old_string: 'a', new_string: 'b' }))?.permissionDecision).toBe('deny')
  expect((await write('NotebookEdit', { notebook_path: `${root}/analyses/other/n.ipynb` }))?.permissionDecision).toBe('deny')
  for (const path of [`${analysis}/lib/x.py`, 'analyses/panel/tests/test_x.py', `${root}/analyses/panel/notes/001-a.md`, `${root}/elsewhere/x.md`, `${root}/analyses-old/x`])
    expect([path, await write('Write', { file_path: path, content: 'x' })]).toEqual([path, undefined])
  // A session Assay did not start is not guarded.
  expect(await hook('write', { tool_name: 'Write', tool_input: { file_path: `${root}/analyses/other/x` }, cwd: root }, { PATH: process.env.PATH })).toBeUndefined()
})

test('the other-analysis guard compares real paths, ignoring case: symlinks, Analyses/, trailing slash and .. forms', async () => {
  const { dir, root, analysis, env } = await scratch()
  await mkdir(join(root, 'analyses/other'), { recursive: true })
  await symlink(root, join(dir, 'link'))
  await symlink(join(root, 'analyses/other'), join(root, 'analyses/panel/to-other'))
  const write = (path: string, over: Record<string, string> = {}) =>
    hook('write', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path, content: 'x' }, cwd: root }, { ...env, ...over })
  const denied = async (path: string, over?: Record<string, string>) => [path, (await write(path, over))?.permissionDecision]
  // Through a symlink to the root, with the root named by its real path or by the link.
  expect(await denied(`${dir}/link/analyses/other/new.py`)).toEqual([`${dir}/link/analyses/other/new.py`, 'deny'])
  expect(await denied(`${root}/analyses/other/new.py`, { ASSAY_ROOT: `${dir}/link` })).toEqual([`${root}/analyses/other/new.py`, 'deny'])
  // A symlink inside the open analysis that leads to another one.
  expect(await denied(`${analysis}/to-other/new.py`)).toEqual([`${analysis}/to-other/new.py`, 'deny'])
  // Case, as on macOS.
  expect(await denied(`${root}/Analyses/other/x`)).toEqual([`${root}/Analyses/other/x`, 'deny'])
  // The open analysis named with a trailing slash, with .., or in another case is still the open one.
  for (const open of [`${analysis}/`, `${root}/analyses/../analyses/panel`, `${root}/ANALYSES/PANEL`]) {
    expect(await write(`${analysis}/lib/x.py`, { ASSAY_ANALYSIS: open })).toBeUndefined()
    expect((await write(`${root}/analyses/other/x.py`, { ASSAY_ANALYSIS: open }))?.permissionDecision).toBe('deny')
  }
})

test('the dictionaries/trusted guard compares real paths, ignoring case', async () => {
  const { dir, root, env } = await scratch()
  await mkdir(join(root, 'trusted'), { recursive: true })
  await symlink(root, join(dir, 'link'))
  const write = (path: string, over: Record<string, string> = {}) =>
    hook('write', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path, content: 'x' }, cwd: root }, { ...env, ...over })
  for (const [path, over] of [[`${root}/Trusted/x.sql`, {}], [`${root}/DICTIONARIES/a.yaml`, {}], [`${dir}/link/trusted/x.sql`, {}], [`${root}/trusted/x.sql`, { ASSAY_ROOT: `${dir}/link` }]] as const) {
    const said = await write(path, over)
    expect([path, said?.permissionDecision]).toEqual([path, 'deny'])
    expect(said?.permissionDecisionReason).toMatch(/change only through the user's approval/)
  }
  expect(await write(`${root}/trusted-old/x.sql`)).toBeUndefined()
})

test('a Write, Edit or NotebookEdit under <root>/notes is refused, pointing to the note tools; reads of it and other folders pass', async () => {
  const { dir, root, analysis, env } = await scratch()
  await mkdir(join(root, 'notes'), { recursive: true })
  await symlink(root, join(dir, 'link'))
  const write = (tool: string, input: object, over: Record<string, string> = {}) =>
    hook('write', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: root }, { ...env, ...over })
  const paths = [`${root}/notes/20261102T181500-a.md`, 'notes/new.md', `${analysis}/../../notes/x.md`, `${root}/Notes/x.md`, `${dir}/link/notes/x.md`, `${root}/notes`]
  for (const path of paths) {
    const said = await write('Write', { file_path: path, content: 'x' })
    expect([path, said?.permissionDecision]).toEqual([path, 'deny'])
    expect(said?.permissionDecisionReason).toContain('mcp__assay__note')
    expect(said?.permissionDecisionReason).toContain('mcp__assay__revise_note')
  }
  expect((await write('Edit', { file_path: `${root}/notes/a.md`, old_string: 'a', new_string: 'b' }))?.permissionDecision).toBe('deny')
  expect((await write('NotebookEdit', { notebook_path: `${root}/notes/a.ipynb` }))?.permissionDecision).toBe('deny')
  expect((await write('Write', { file_path: `${root}/notes/x.md` }, { ASSAY_ROOT: `${dir}/link` }))?.permissionDecision).toBe('deny')
  for (const path of [`${root}/notes-old/x.md`, `${root}/elsewhere/notes/x.md`, `${analysis}/notes/x.md`])
    expect([path, await write('Write', { file_path: path, content: 'x' })]).toEqual([path, undefined])
})

test('the prompt rules send findings to the note tools and no longer name notes.md, new_note or [[slug]]', async () => {
  const { env } = await scratch()
  const rules = (await hook('prompt', { prompt: 'x' }, env))?.additionalContext ?? ''
  for (const part of ['mcp__assay__note', 'one idea per note', '[<slug> q N]', '[[ID]]', 'mcp__assay__revise_note', 'never Write or Edit under notes/'])
    expect(rules).toContain(part)
  for (const gone of ['new_note', 'notes.md', '[[slug]]', '[q NNN]']) expect(rules).not.toContain(gone)
})

test('outside an Assay session a prompt carries no rule', async () => {
  expect(await hook('prompt', { prompt: 'hi' }, { PATH: process.env.PATH })).toBeUndefined()
})

// The hooks' decisions and helpers called in-process (hooks.test.ts runs the bundled scripts, which coverage does not
// follow): each branch of bashDecision, writeDecision and promptDecision, and the shared io helpers.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BASH_PYTHON_DENY } from '../core/bashGuard.ts'
import type { Proc, RunResult } from '../server/proc.ts'
import { expect } from '../testing/expect.ts'
import { bashDecision, promptDecision, writeDecision } from './decide.ts'
import { addContext, deny, field, toolInput } from './io.ts'
import { recordState } from './recordState.ts'

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'assay-decide-'))
  const root = join(dir, 'notes-src')
  const analysis = join(root, 'analyses/panel')
  await mkdir(join(analysis, '.assay'), { recursive: true })
  await writeFile(join(analysis, 'analysis.yaml'), 'title: Panel sites\n')
  return { dir, root, analysis, env: { ASSAY_ANALYSIS: analysis, ASSAY_ROOT: root, ASSAY_VENV: join(dir, 'venv') } }
}

const noChild: Proc['spawn'] = () => {
  throw new Error('no child')
}
const noProc: Proc = { run: () => Promise.reject(new Error('no program')), spawn: noChild }
const procPrinting = (stdout: string, seen: string[][] = []): Proc => ({
  run: (argv): Promise<RunResult> => {
    seen.push([...argv])
    return Promise.resolve({ exitCode: 0, stdout, stderr: '' })
  },
  spawn: noChild,
})

const context = (said: ReturnType<typeof addContext> | undefined) => said?.hookSpecificOutput.additionalContext ?? ''

test('io helpers read strings and objects, and shape the two answers', () => {
  expect(field({ a: 'x', b: 3 }, 'a')).toBe('x')
  expect(field({ b: 3 }, 'b')).toBe('')
  expect(field({}, 'c')).toBe('')
  expect(toolInput({ tool_input: { command: 'ls' } })).toEqual({ command: 'ls' })
  expect(toolInput({ tool_input: 'ls' })).toEqual({})
  expect(toolInput({ tool_input: null })).toEqual({})
  expect(toolInput({})).toEqual({})
  expect(deny('no').hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' })
  expect(addContext('hi').hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: 'hi' })
})

test('bashDecision refuses Python only in an Assay session', () => {
  const python = { tool_input: { command: 'python x.py' } }
  expect(bashDecision(python, { ASSAY_ANALYSIS: '/a' })?.hookSpecificOutput.permissionDecisionReason).toBe(BASH_PYTHON_DENY)
  expect(bashDecision(python, {})).toBeUndefined()
  expect(bashDecision({ tool_input: { command: 'ls' } }, { ASSAY_ANALYSIS: '/a' })).toBeUndefined()
  expect(bashDecision({}, { ASSAY_ANALYSIS: '/a' })).toBeUndefined()
})

test('writeDecision does nothing without a session, a root or a path', async () => {
  const { root, analysis } = await scratch()
  const input = { tool_input: { file_path: `${root}/trusted/x.sql` } }
  expect(await writeDecision(input, {})).toBeUndefined()
  expect(await writeDecision(input, { ASSAY_ANALYSIS: analysis })).toBeUndefined()
  expect(await writeDecision(input, { ASSAY_ROOT: root })).toBeUndefined()
  expect(await writeDecision({ tool_input: {} }, { ASSAY_ANALYSIS: analysis, ASSAY_ROOT: root })).toBeUndefined()
})

test('writeDecision reads notebook_path, resolves against cwd or the analysis, and trims the root\'s trailing slashes', async () => {
  const { root, analysis, env } = await scratch()
  const notebook = await writeDecision({ tool_input: { notebook_path: `${root}/trusted/n.ipynb` } }, env)
  expect(notebook?.hookSpecificOutput.permissionDecision).toBe('deny')
  // No cwd: a relative path is taken from the open analysis.
  const relative = await writeDecision({ tool_input: { file_path: '../../trusted/x.sql' } }, env)
  expect(relative?.hookSpecificOutput.permissionDecisionReason).toMatch(/change only through the user's approval/)
  const slashed = await writeDecision({ tool_input: { file_path: `${root}/trusted/x.sql` }, cwd: analysis }, { ...env, ASSAY_ROOT: `${root}///` })
  expect(slashed?.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(await writeDecision({ tool_input: { file_path: `${analysis}/lib/x.py` }, cwd: analysis }, { ...env, ASSAY_ROOT: `${root}//` })).toBeUndefined()
})

test('the other-analysis refusal names the open analysis by its title, or by its folder when analysis.yaml is missing or has none', async () => {
  const { root, analysis, env } = await scratch()
  const other = { tool_input: { file_path: `${root}/analyses/other/x.py` } }
  const reason = async () => (await writeDecision(other, env))?.hookSpecificOutput.permissionDecisionReason
  expect(await reason()).toBe('analyses/other is not the open analysis. The open analysis is "Panel sites" (analyses/panel/): write only there.')
  await writeFile(join(analysis, 'analysis.yaml'), 'created: 2026-11-02\n')
  expect(await reason()).toContain('The open analysis is "panel"')
  await writeFile(join(analysis, 'analysis.yaml'), '')
  expect(await reason()).toContain('The open analysis is "panel"')
  // Not a file at all: reading it fails.
  expect(await writeDecision(other, { ...env, ASSAY_ANALYSIS: join(root, 'analyses/ghost') })).toBeDefined()
})

test('a path under a missing folder is resolved from its deepest existing ancestor', async () => {
  const { root, env } = await scratch()
  const said = await writeDecision({ tool_input: { file_path: `${root}/trusted/deep/er/x.sql` } }, env)
  expect(said?.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(await writeDecision({ tool_input: { file_path: `${root}/elsewhere/deep/x.sql` } }, env)).toBeUndefined()
})

test("the analysis's .assay/ and queries/ and the root's git are Assay's alone, in any case (audit PI-1, PI-2, PI-3)", async () => {
  const { root, analysis, env } = await scratch()
  for (const path of [
    `${analysis}/.assay/requests/0001.json`,
    `${analysis}/.ASSAY/trust/x.json`,
    `${analysis}/queries/001_x.sql`,
    `${analysis}/Queries/001_x.csv`,
    `${analysis}/.git/hooks/pre-commit`,
    `${root}/.git/hooks/pre-commit`,
    `${root}/.git`,
    '.assay/user-runs.json',
  ]) {
    const said = await writeDecision({ tool_input: { file_path: path } }, env)
    expect(`${path}: ${said?.hookSpecificOutput.permissionDecisionReason ?? 'allowed'}`).toMatch('which only Assay writes')
  }
  for (const path of [`${analysis}/lib/queries.py`, `${analysis}/assay.md`, `${analysis}/.assayrc`]) {
    expect(await writeDecision({ tool_input: { file_path: path } }, env)).toBeUndefined()
  }
})

test("Assay's own backend and venv are not Claude's to write (audit UP-1)", async () => {
  const { dir, env } = await scratch()
  const backend = join(dir, 'backend/0.1.0')
  const withInstall = { ...env, ASSAY_BACKEND: `${backend}/`, ASSAY_VENV: join(dir, 'venv') }
  for (const path of [`${backend}/out/hooks/write.mjs`, join(dir, 'venv/lib/python3.12/site-packages/analysis_sql.py')]) {
    const said = await writeDecision({ tool_input: { file_path: path } }, withInstall)
    expect(said?.hookSpecificOutput.permissionDecisionReason).toMatch('which only Assay writes')
  }
  expect(await writeDecision({ tool_input: { file_path: join(dir, 'backend-notes.md') } }, withInstall)).toBeUndefined()
})

test('a dangling symlink is followed to where writing through it would create the file (audit PI-6)', async () => {
  const { root, analysis, env } = await scratch()
  await mkdir(join(analysis, 'lib'), { recursive: true })
  await mkdir(join(root, 'trusted'), { recursive: true })
  await symlink(join(root, 'trusted/new.sql'), join(analysis, 'lib/x.sql'))
  await symlink(join(analysis, 'lib/x.sql'), join(analysis, 'lib/y.sql'))
  for (const name of ['x.sql', 'y.sql']) {
    const said = await writeDecision({ tool_input: { file_path: `${analysis}/lib/${name}` } }, env)
    expect(said?.hookSpecificOutput.permissionDecision).toBe('deny')
  }
  // A loop of links resolves to nothing guarded and does not hang.
  await symlink(join(analysis, 'lib/b'), join(analysis, 'lib/a'))
  await symlink(join(analysis, 'lib/a'), join(analysis, 'lib/b'))
  expect(await writeDecision({ tool_input: { file_path: `${analysis}/lib/a` } }, env)).toBeUndefined()
})

test('a protected folder that is a symlink protects its name and its destination, existing or dangling (audit PI-6)', async () => {
  const { dir, root, analysis, env } = await scratch()
  const links = [
    [join(root, 'trusted'), 'relocated-trusted'],
    [join(root, 'notes'), 'relocated-notes'],
    [join(analysis, '.assay'), 'relocated-assay'],
    [join(analysis, 'queries'), 'relocated-queries'],
  ] as const
  await rm(join(analysis, '.assay'), { recursive: true })
  for (const [link, destination] of links) {
    const target = join(dir, destination)
    await mkdir(target, { recursive: true })
    await symlink(target, link)
    for (const path of [join(link, 'f.sql'), join(target, 'f.sql')]) {
      const said = await writeDecision({ tool_input: { file_path: path } }, env)
      expect(`${path}: ${said?.hookSpecificOutput.permissionDecision ?? 'allowed'}`).toBe(`${path}: deny`)
    }
  }
  // A link to a folder that does not exist yet: the name and the destination are both refused.
  await rm(join(root, 'dictionaries'), { recursive: true, force: true })
  await symlink(join(dir, 'later'), join(root, 'dictionaries'))
  for (const path of [join(root, 'dictionaries/f.yaml'), join(dir, 'later/f.yaml')]) {
    expect((await writeDecision({ tool_input: { file_path: path } }, env))?.hookSpecificOutput.permissionDecision).toBe('deny')
  }
  expect(await writeDecision({ tool_input: { file_path: join(dir, 'unrelated/f.sql') } }, env)).toBeUndefined()
})

test('a ".." after a protected-folder link is taken from the link destination, not the link name (audit PI-6)', async () => {
  const { dir, root, analysis, env } = await scratch()
  const links = [
    [join(root, 'trusted'), 'moved-trusted'],
    [join(root, 'notes'), 'moved-notes'],
    [join(analysis, '.assay'), 'moved-assay'],
    [join(analysis, 'queries'), 'moved-queries'],
  ] as const
  await rm(join(analysis, '.assay'), { recursive: true })
  for (const [link, destination] of links) {
    await mkdir(join(dir, destination), { recursive: true })
    await symlink(join(dir, destination), link)
    // The link, then "..", lands beside the destination, not beside the link: it names the destination's own file.
    for (const path of [`${link}/../${destination}/x.py`, `${link}/sub/../../${destination}/x.py`]) {
      const said = await writeDecision({ tool_input: { file_path: path } }, env)
      expect(`${path}: ${said?.hookSpecificOutput.permissionDecision ?? 'allowed'}`).toBe(`${path}: deny`)
    }
  }
  // A plain ".." that stays outside protection is still allowed, as is one through a protected folder's real directory.
  await mkdir(join(analysis, 'lib'), { recursive: true })
  await mkdir(join(root, 'plain'), { recursive: true })
  for (const path of [`${analysis}/lib/../ok.py`, `${root}/plain/../ok.py`, `${dir}/moved-trusted/../ok.py`, `${root}/trusted/../ok.py`]) {
    expect(await writeDecision({ tool_input: { file_path: path } }, env)).toBeUndefined()
  }
  // A ".." in a part that does not exist cannot cross a link.
  expect(await writeDecision({ tool_input: { file_path: `${analysis}/lib/gone/../ok.py` } }, env)).toBeUndefined()
})

test('promptDecision does nothing without an analysis and a root', async () => {
  expect(await promptDecision({}, noProc)).toBeUndefined()
  expect(await promptDecision({ ASSAY_ANALYSIS: '/a' }, noProc)).toBeUndefined()
  expect(await promptDecision({ ASSAY_ROOT: '/r' }, noProc)).toBeUndefined()
})

test('promptDecision names the kernel python, else the venv python when built, else plain python', async () => {
  const { dir, analysis, env } = await scratch()
  const withoutVenv = { ASSAY_ANALYSIS: env.ASSAY_ANALYSIS, ASSAY_ROOT: env.ASSAY_ROOT }
  expect(context(await promptDecision(withoutVenv, noProc))).toContain('cd analyses/panel && python -m pytest tests')
  expect(context(await promptDecision(env, noProc))).toContain('cd analyses/panel && python -m pytest tests')
  await mkdir(join(dir, 'venv/bin'), { recursive: true })
  await writeFile(join(dir, 'venv/bin/python'), '')
  expect(context(await promptDecision(env, noProc))).toContain(`cd analyses/panel && ${dir}/venv/bin/python -m pytest tests`)
  await writeFile(join(analysis, '.assay/session.json'), JSON.stringify({ python: '/k/bin/python' }))
  expect(context(await promptDecision(env, noProc))).toContain('cd analyses/panel && /k/bin/python -m pytest tests')
  for (const bad of ['{', 'null', '{"python":3}', '[]']) {
    await writeFile(join(analysis, '.assay/session.json'), bad)
    expect([bad, context(await promptDecision(env, noProc)).includes(`${dir}/venv/bin/python -m pytest`)]).toEqual([bad, true])
  }
})

test('promptDecision takes the recorded runs and step notices once, ignoring files that are not lists', async () => {
  const { analysis, env } = await scratch()
  const runs = join(analysis, '.assay/user-runs.json')
  const notices = join(analysis, '.assay/step-notices.json')
  await writeFile(runs, JSON.stringify([{ number: 2, language: 'sql' }]))
  await writeFile(notices, JSON.stringify(['q001 step a: bad grain', 4, null]))
  const said = context(await promptDecision(env, noProc))
  expect(said).toContain('Since your last turn the user ran: 002 sql.')
  expect(said).toContain('Step checks failed since your last turn:\n- q001 step a: bad grain')
  expect(await readFile(runs, 'utf8').catch(() => 'gone')).toBe('gone')
  expect(await readFile(notices, 'utf8').catch(() => 'gone')).toBe('gone')
  for (const bad of ['not json', '{"number":1}', '"x"']) {
    await writeFile(runs, bad)
    await writeFile(notices, bad)
    const text = context(await promptDecision(env, noProc))
    expect([bad, text.includes('Since your last turn'), text.includes('Step checks failed')]).toEqual([bad, false, false])
  }
})

test('promptDecision lists the trusted calculations only when the venv python prints a list', async () => {
  const { dir, root, analysis, env } = await scratch()
  const list = { calculations: [{ name: 'by_site', kind: 'sql', file: 'c.sql', description: 'Per site.', parameters: [], commit: 'abc', dirty: false }], problems: [] }
  await mkdir(join(dir, 'venv/bin'), { recursive: true })
  const seen: string[][] = []
  expect(context(await promptDecision(env, procPrinting(JSON.stringify(list), seen)))).toContain('- by_site(): Per site.')
  expect(seen).toEqual([[`${dir}/venv/bin/python`, '-I', '-B', '-m', 'analysis_trust', 'list', root]])
  for (const out of ['', 'not json', 'null', '5', JSON.stringify({ error: 'broken' })])
    expect([out, context(await promptDecision(env, procPrinting(out))).includes('by_site')]).toEqual([out, false])
  expect(context(await promptDecision(env, noProc))).not.toContain('by_site')
  // Without Assay's venv the helper is not run.
  const unrun: string[][] = []
  await promptDecision({ ASSAY_ANALYSIS: analysis, ASSAY_ROOT: root }, procPrinting(JSON.stringify(list), unrun))
  expect(unrun).toEqual([])
})

test('recordState writes the state for an event that moves it, and nothing otherwise', async () => {
  const { analysis } = await scratch()
  const file = join(analysis, '.assay/claude.json')
  const now = new Date('2026-11-11T10:00:00Z')
  await recordState({ hook_event_name: 'Notification' }, analysis, now)
  await recordState({ hook_event_name: 'Stop' }, undefined, now)
  expect(await readFile(file, 'utf8').catch(() => 'none')).toBe('none')
  await recordState({ hook_event_name: 'Stop' }, analysis, now)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ state: 'idle', at: '2026-11-11T10:00:00.000Z' })
  await recordState({ hook_event_name: 'UserPromptSubmit' }, analysis, now)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ state: 'working', at: '2026-11-11T10:00:00.000Z' })
})

test('recordState never fails the turn when the folder cannot be written', async () => {
  const { dir } = await scratch()
  const blocker = join(dir, 'file')
  await writeFile(blocker, '')
  await recordState({ hook_event_name: 'Stop' }, blocker, new Date())
})

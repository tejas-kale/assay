// The backend end to end, as the app and Claude use it: the bundled server over MCP with a real kernel in a real venv,
// requests through .assay/requests/, and the bundled hooks on real files. Run with `npm run test:integration`.
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'

import { bundle, runNode } from '../../src/testing/bundle.ts'
import { expect } from '../../src/testing/expect.ts'
import { until } from '../../src/server/testing.ts'
import { server, world } from './harness.ts'

test('a SQL run claims a number, writes its files and leaves runs.json with nothing running', { timeout: 180_000 }, async (t) => {
  const w = await world(t)
  const s = await server(t, w)
  expect(await s.call('sql', { sql: 'SELECT site, n FROM sites', slug: 'sites' })).toMatch(/^Query 001: 2 rows\. Columns: site, n\nsite +n\nnorth +2\nsouth +5\n/)
  expect(await s.file('queries/001_sites.sql')).toMatch(/SELECT site, n FROM sites\n$/)
  expect(await s.file('queries/001_sites.csv')).toBe('site,n\nnorth,2\nsouth,5\n')
  expect(JSON.parse((await s.file('.assay/runs.json')) ?? '{}')).toMatchObject({ running: null, failed: {} })
})

test("a Python run in the real kernel reads a SQL run's rows with q(N)", { timeout: 180_000 }, async (t) => {
  const w = await world(t)
  const s = await server(t, w)
  await s.call('sql', { sql: 'SELECT site, n FROM sites', slug: 'sites' })
  expect(await s.kernelIdle()).toBe(true)
  expect(await s.call('python', { code: 'rows = q(1)\nprint(int(rows.n.astype(int).sum()))', slug: 'total' })).toMatch(/^Run 002: ok \(\d+\.\d s\)\.\n7$/)
  expect(await s.file('queries/002_total.py')).toMatch(/rows = q\(1\)/)
})

test("the app's kernel requests: a Python run, interrupt, restart and replay", { timeout: 180_000 }, async (t) => {
  const s = await server(t, await world(t))
  expect(await s.kernelIdle()).toBe(true)
  expect(await s.ask({ kind: 'python', code: 'y = 2', slug: 'py' })).toMatchObject({ number: 1 })
  expect(await s.ask({ kind: 'interrupt' })).toMatchObject({ ok: true })
  expect(await s.ask({ kind: 'restart' })).toMatchObject({ ok: true })
  expect(await s.ask({ kind: 'replay', runs: [1] })).toMatchObject({ ok: true })
  expect(await s.file('queries/002_py.py')).toBe('# author: user\n# replay: 001\ny = 2\n')
})

const STEPPED = `WITH
-- grain: site
big_sites AS (SELECT site, n FROM sites WHERE n > 1)
-- grain: site
SELECT site, n FROM big_sites`

test('a Steps request runs each CTE of a SQL run, with its preview and counts', { timeout: 180_000 }, async (t) => {
  const w = await world(t)
  const s = await server(t, w)
  expect(await s.call('sql', { sql: STEPPED, slug: 'big' })).toMatch(/^Query 001: 2 rows/)
  expect(await s.ask({ kind: 'steps', run: 1 })).toMatchObject({ ok: true })
  const steps = JSON.parse((await s.file('queries/001.steps.json')) ?? '{}') as { status: string; steps: { name: string; status: string; counts?: object }[] }
  expect(steps.status).toBe('done')
  expect(steps.steps.map(({ name, status }) => [name, status])).toEqual([['big_sites', 'ok'], ['final', 'ok']])
  expect(steps.steps[0]?.counts).toEqual({ assay_rows: '3', assay_grain_rows: '3' })
  expect(await s.file('queries/001.1_big_sites.csv')).toBe('site,n\nnorth,2\nsouth,5\n')
  expect(JSON.parse((await s.file('queries/001.lineage.json')) ?? '{}')).toMatchObject({ nodes: [{ id: 'sites', kind: 'table' }, { id: 'big_sites', kind: 'cte' }, { id: 'final', kind: 'final' }] })
})

// A trusted calculation runs on the warehouse through the Python connector, which no fake answers: the test stops at
// the committed calculation being found, and the include expansion runs through the CLI.
test('the trusted tool finds the committed calculation, and SQL including a trusted block runs expanded', { timeout: 180_000 }, async (t) => {
  const w = await world(t)
  const s = await server(t, w)
  expect(await s.call('trusted', { name: 'nope' })).toMatch(/^No trusted calculation nope\.[\s\S]*site_total/)
  const included = 'WITH\n-- grain: site\nevery_site AS ({{ all_sites() }})\n-- grain: site\nSELECT site, n FROM every_site'
  expect(await s.call('sql', { sql: included, slug: 'included' })).toMatch(/all_sites[\s\S]*Query 001: 2 rows\./)
  expect(await s.file('queries/001_included.sql')).toMatch(/-- built from: all_sites@[0-9a-f]{12}[\s\S]*\{\{ all_sites\(\) \}\}/)
  expect(await s.file('queries/001.expanded.sql')).toMatch(/FROM cint\.mkt\.sites/)
})

async function hook(name: string, input: object, env: Record<string, string>) {
  const ran = await runNode(join(await bundle(), 'hooks', `${name}.mjs`), JSON.stringify(input), env)
  expect([name, ran.code, ran.stderr]).toEqual([name, 0, ''])
  return ran.stdout.trim() ? (JSON.parse(ran.stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput : undefined
}

test('the hooks on real files: Python through Bash and writes into trusted/ are refused; a prompt carries the rules and the trusted calculations', { timeout: 180_000 }, async (t) => {
  const w = await world(t)
  const bash = await hook('bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'python3 -c "print(1)"' } }, w.env)
  expect(bash?.permissionDecision).toBe('deny')
  const write = await hook('write', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(w.root, 'trusted/all_sites.sql') }, cwd: w.analysis }, w.env)
  expect(write?.permissionDecision).toBe('deny')
  expect(await hook('write', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(w.analysis, 'lib/draft.sql'), content: 'x' }, cwd: w.analysis }, w.env)).toBeUndefined()
  const prompt = await hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'how many sites?' }, w.env)
  expect(prompt?.additionalContext).toContain('mcp__assay__python')
  expect(prompt?.additionalContext).toContain('site_total')
})

test("rich-row edits and re-runs are new user runs naming their saved source", { timeout: 180_000 }, async t => {
  const w = await world(t)
  const s = await server(t, w)
  await s.call('sql', { sql: 'SELECT site, n FROM sites', slug: 'sites' })
  await s.call('python', { code: 'print(7)', slug: 'total' })
  const editor = join(w.dir, 'editor.sh')
  await writeFile(editor, '#!/bin/sh\nprintf "print(8)\\n" > "$1"\n')
  for (const [action, file] of [['rerun', '001_sites.sql'], ['edit', '002_total.py']]) {
    const ran = await runNode(join(await bundle(), 'cli/run-action.mjs'), JSON.stringify({ action, file }), { ...w.env, EDITOR: `/bin/sh '${editor}'` })
    const sent = JSON.parse(ran.stdout) as { ok: boolean; id: string }
    expect(sent.ok).toBe(true)
    const reply = `.assay/replies/${sent.id}.json`
    expect(await until(async () => (await s.file(reply)) !== undefined, 120_000)).toBe(true)
    expect(JSON.parse((await s.file(reply)) ?? '{}')).toMatchObject({ number: action === 'rerun' ? 3 : 4 })
  }
  expect(await s.file('queries/003_query.sql')).toBe('-- author: user\n-- from: 001\nSELECT site, n FROM sites\n')
  expect(await s.file('queries/004_query.py')).toBe('# author: user\n# from: 002\nprint(8)\n')
  expect(await s.file('queries/001_sites.sql')).toBe('SELECT site, n FROM sites\n')
  expect(await s.file('queries/002_total.py')).toBe('print(7)\n')
})

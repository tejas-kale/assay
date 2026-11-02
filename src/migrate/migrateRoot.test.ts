// The migration script run as a command on a scratch root, compared to the expected tree.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { expect } from '../testing/expect.ts'

const run = promisify(execFile)
const MARK = '# Marks this folder for the analysis mod.\n'
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12)

async function put(root: string, path: string, text: string, when?: Date) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), text)
  if (when) await utimes(join(root, path), when, when)
}

/** The old layout: marked and unmarked folders in all three parents, and a slug clash (alpha). */
async function scratchRoot() {
  const root = join(await mkdtemp(join(tmpdir(), 'assay-migrate-')), 'notes-src')
  await put(root, 'analyses/alpha/.analysis', `${MARK}profile: DEFAULT\nwarehouse: w1 # mine\n`)
  await put(root, 'analyses/alpha/queries/002_b.sql', 'SELECT 2\n', at(2026, 3, 8))
  await put(root, 'analyses/alpha/queries/001_a.sql', 'SELECT 1\n', at(2026, 3, 5))
  await put(root, 'analyses/alpha/notes.md', 'a fact\n')
  await put(root, 'analyses/beta_two/.analysis', '')
  await put(root, 'analyses/plain/notes.md', 'no marker\n')
  await put(root, 'analyses/done/analysis.yaml', 'title: Already done\n')
  await put(root, 'investigations/CLAUDE.md', 'old mod text\n')
  await put(root, 'investigations/gamma-run/.analysis', MARK)
  await put(root, 'investigations/gamma-run/threads.md', '## Open\n\n## Closed\n')
  await put(root, 'investigations/alpha/.analysis', MARK + 'pg_database: panel\n')
  await put(root, 'investigations/alpha/notes.md', 'the other alpha\n')
  await put(root, 'investigations/bare/notes.md', 'unmarked\n')
  await put(root, 'explorations/delta/.analysis', MARK)
  await put(root, 'explorations/delta/lib/__init__.py', '')
  // Folder times last: the migration must keep them (the picker sorts by them).
  for (const [path, when] of [['analyses/alpha', at(2026, 4, 1)], ['analyses/beta_two', at(2026, 4, 2)], ['investigations/gamma-run', at(2026, 1, 10)], ['investigations/alpha', at(2026, 2, 3)], ['explorations/delta', at(2026, 5, 6)]] as const)
    await utimes(join(root, path), when, when)
  return root
}

/** Every file under `root` with its text, and every folder's change time. */
async function tree(root: string, at = ''): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    const path = at ? `${at}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      Object.assign(found, await tree(root, path))
      found[`${path}/`] = String((await stat(join(root, path))).mtime.getTime())
    } else found[path] = await readFile(join(root, path), 'utf8')
  }
  return found
}

const migrate = (root: string, ...flags: string[]) => run(process.execPath, [resolve('scripts/migrate-root.ts'), root, ...flags]).then(out => out.stdout)

test('a dry run reports every folder and changes nothing', async () => {
  const root = await scratchRoot()
  const before = await tree(root)
  const out = await migrate(root)
  expect(await tree(root)).toEqual(before)
  expect(out).toContain('analyses/alpha: write analysis.yaml (title "Alpha", created 2026-03-05), remove .analysis\n')
  expect(out).toContain('analyses/beta_two: move to analyses/beta-two (slug taken, numbered), write analysis.yaml (title "Beta two", created 2026-04-02), remove .analysis\n')
  expect(out).toContain('investigations/alpha: move to analyses/alpha-2 (slug taken, numbered), write analysis.yaml (title "Alpha", created 2026-02-03), remove .analysis\n')
  expect(out).toContain('investigations/gamma-run: move to analyses/gamma-run, write analysis.yaml (title "Gamma run", created 2026-01-10), remove .analysis\n')
  expect(out).toContain('explorations/delta: move to analyses/delta, write analysis.yaml (title "Delta", created 2026-05-06), remove .analysis\n')
  expect(out).toContain('Left alone:\n  analyses/plain (no .analysis)\n  investigations/bare (no .analysis)\n')
  expect(out).toContain('Dry run: nothing changed.')
})

test('--apply writes analysis.yaml, moves marked folders into analyses/, removes .analysis, leaves the rest', async () => {
  const root = await scratchRoot()
  const before = await tree(root)
  const out = await migrate(root, '--apply')
  expect(out).toContain('Applied: 5 folders.')
  const after = await tree(root)
  const time = (path: string) => before[path]
  expect(after).toEqual({
    'analyses/alpha/analysis.yaml': 'title: Alpha\ncreated: 2026-03-05\nprofile: DEFAULT\nwarehouse: w1 # mine\n',
    'analyses/alpha/notes.md': 'a fact\n',
    'analyses/alpha/queries/001_a.sql': 'SELECT 1\n',
    'analyses/alpha/queries/002_b.sql': 'SELECT 2\n',
    'analyses/alpha/queries/': before['analyses/alpha/queries/']!,
    'analyses/alpha/': time('analyses/alpha/')!,
    'analyses/alpha-2/analysis.yaml': 'title: Alpha\ncreated: 2026-02-03\npg_database: panel\n',
    'analyses/alpha-2/notes.md': 'the other alpha\n',
    'analyses/alpha-2/': time('investigations/alpha/')!,
    'analyses/beta-two/analysis.yaml': 'title: Beta two\ncreated: 2026-04-02\n',
    'analyses/beta-two/': time('analyses/beta_two/')!,
    'analyses/delta/analysis.yaml': 'title: Delta\ncreated: 2026-05-06\n',
    'analyses/delta/lib/__init__.py': '',
    'analyses/delta/lib/': before['explorations/delta/lib/']!,
    'analyses/delta/': time('explorations/delta/')!,
    'analyses/done/analysis.yaml': 'title: Already done\n',
    'analyses/done/': time('analyses/done/')!,
    'analyses/gamma-run/analysis.yaml': 'title: Gamma run\ncreated: 2026-01-10\n',
    'analyses/gamma-run/threads.md': '## Open\n\n## Closed\n',
    'analyses/gamma-run/': time('investigations/gamma-run/')!,
    'analyses/plain/notes.md': 'no marker\n',
    'analyses/plain/': time('analyses/plain/')!,
    'investigations/CLAUDE.md': 'old mod text\n',
    'investigations/bare/notes.md': 'unmarked\n',
    'investigations/bare/': time('investigations/bare/')!,
    'investigations/': after['investigations/']!,
    'explorations/': after['explorations/']!,
    'analyses/': after['analyses/']!,
  })
})

test('a second run changes nothing and says so', async () => {
  const root = await scratchRoot()
  await migrate(root, '--apply')
  const once = await tree(root)
  const out = await migrate(root, '--apply')
  expect(await tree(root)).toEqual(once)
  expect(out).toContain('Nothing to migrate.')
  expect(out).toContain('Left alone:\n  analyses/plain (no .analysis)\n  investigations/bare (no .analysis)\n')
})

test('a folder holding both .analysis and analysis.yaml is left alone, not overwritten', async () => {
  const root = await scratchRoot()
  await put(root, 'analyses/both/.analysis', MARK)
  await put(root, 'analyses/both/analysis.yaml', 'title: Mine\n')
  const out = await migrate(root, '--apply')
  expect(out).toContain('analyses/both (has both .analysis and analysis.yaml; nothing is overwritten)')
  expect(await readFile(join(root, 'analyses/both/analysis.yaml'), 'utf8')).toBe('title: Mine\n')
  expect(await readFile(join(root, 'analyses/both/.analysis'), 'utf8')).toBe(MARK)
})

test('a folder whose name is not a slug moves to its slug; a slug that exists, even as a file, is numbered', async () => {
  const root = await scratchRoot()
  await put(root, 'analyses/Old_Thing/.analysis', MARK)
  await put(root, 'analyses/old-thing', 'a file in the way\n')
  await put(root, 'explorations/Old Thing/.analysis', MARK)
  const out = await migrate(root, '--apply')
  expect(out).toContain('analyses/Old_Thing: move to analyses/old-thing-2 (slug taken, numbered), write analysis.yaml (title "Old Thing"')
  expect(out).toContain('explorations/Old Thing: move to analyses/old-thing-3')
  expect(await readFile(join(root, 'analyses/old-thing'), 'utf8')).toBe('a file in the way\n')
  expect(await readFile(join(root, 'analyses/old-thing-2/analysis.yaml'), 'utf8')).toMatch(/^title: Old Thing\n/)
  expect((await stat(join(root, 'analyses/Old_Thing')).catch(() => undefined))).toBe(undefined)
})

test('a name that is already a slug stays; a target that exists as a file gets a numbered slug', async () => {
  const root = await scratchRoot()
  await put(root, 'analyses/delta', 'a file in the way\n')
  const out = await migrate(root, '--apply')
  expect(out).toContain('explorations/delta: move to analyses/delta-2 (slug taken, numbered)')
  expect(await readFile(join(root, 'analyses/delta'), 'utf8')).toBe('a file in the way\n')
  expect(await readFile(join(root, 'analyses/delta-2/analysis.yaml'), 'utf8')).toMatch(/^title: Delta\n/)
  expect(await readFile(join(root, 'analyses/alpha/analysis.yaml'), 'utf8')).toMatch(/^title: Alpha\n/)
})

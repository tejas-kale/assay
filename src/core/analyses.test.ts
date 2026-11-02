import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAnalysis, listAnalyses, openAnalysis, parseAnalysisFile, renameAnalysis, setTitle, slugFor } from './analyses.ts'
import type { FsPort } from './analyses.ts'

/** An in-memory port: `dirs` maps a folder to its mtime; `files` maps a file path to its text. */
function fakePort(dirs: Record<string, number>, files: Record<string, string> = {}) {
  const port: FsPort = {
    readdir: async path => {
      const prefix = `${path}/`
      const names = [...Object.keys(dirs), ...Object.keys(files)].filter(each => each.startsWith(prefix)).map(each => each.slice(prefix.length).split('/')[0] ?? '')
      if (names.length === 0 && !(path in dirs)) throw new Error('ENOENT')
      return [...new Set(names)]
    },
    stat: async path => {
      if (path in dirs) return { isDirectory: true, mtimeMs: dirs[path] ?? 0 }
      if (path in files) return { isDirectory: false, mtimeMs: 1 }
      return undefined
    },
    exists: async path => path in dirs || path in files,
    mkdir: async path => {
      dirs[path] = 1
    },
    readFile: async path => {
      const text = files[path]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    writeFile: async (path, text) => {
      files[path] = text
    },
  }
  return { port, files, dirs }
}

test('analysis.yaml: typed title, created and target keys; unknown keys and comments are ignored by the reader', () => {
  const text = '# mine\ntitle: Churn in Q3\ncreated: 2026-11-02\nprofile: Cint mkt          # optional\nwarehouse: "abc123"\npg_database: panel\nextra: 1\n'
  assert.deepEqual(parseAnalysisFile(text), { title: 'Churn in Q3', created: '2026-11-02', profile: 'Cint mkt', warehouse: 'abc123', pgDatabase: 'panel' })
  assert.deepEqual(parseAnalysisFile(''), {})
  assert.equal(parseAnalysisFile("title: 'It''s: odd'\n").title, "It's: odd")
  assert.equal(parseAnalysisFile('Title: Upper\n').title, 'Upper')
})

test('a title edit rewrites the title line only: other keys, unknown keys and comments stay', () => {
  const text = '# mine\ntitle: Old\ncreated: 2026-11-02\nnotes: [a, b] # kept\n'
  assert.equal(setTitle(text, 'New: with colon'), '# mine\ntitle: "New: with colon"\ncreated: 2026-11-02\nnotes: [a, b] # kept\n')
  assert.equal(setTitle('created: 2026-11-02\n', 'Fresh'), 'title: Fresh\ncreated: 2026-11-02\n')
  // Round trip: what setTitle writes, parseAnalysisFile reads back.
  for (const title of ['Plain', 'a: b', 'has # hash', '  padded ', 'say "hi"', 'true', '42', "it's"]) {
    assert.equal(parseAnalysisFile(setTitle('title: x\n', title)).title, title.trim(), title)
  }
})

test('a title edit keeps CRLF line endings and never adds a second title line', () => {
  assert.equal(setTitle('title: Old\r\ncreated: 2026-11-02\r\n', 'New'), 'title: New\r\ncreated: 2026-11-02\r\n')
  assert.equal(setTitle('created: 2026-11-02\r\n', 'New'), 'title: New\r\ncreated: 2026-11-02\r\n')
})

test('slugFor: the note slug rule, numbered from -2 on a clash', () => {
  assert.equal(slugFor('Churn in Q3', []), 'churn-in-q3')
  assert.equal(slugFor('Churn in Q3', ['churn-in-q3']), 'churn-in-q3-2')
  assert.equal(slugFor('Churn in Q3', ['churn-in-q3', 'churn-in-q3-2']), 'churn-in-q3-3')
  assert.equal(slugFor('Churn in Q3', ['other']), 'churn-in-q3')
})

test('listAnalyses: analyses/ folders holding analysis.yaml, newest first, titled; others skipped', async () => {
  const { port } = fakePort(
    { '/r/analyses': 5, '/r/analyses/old': 10, '/r/analyses/new': 30, '/r/analyses/bare': 99, '/r/analyses/.git': 99, '/r/investigations/x': 50 },
    {
      '/r/analyses/old/analysis.yaml': 'title: Older one\n',
      '/r/analyses/new/analysis.yaml': 'title: Newer one\n',
      '/r/analyses/readme.md': '',
      '/r/investigations/x/analysis.yaml': 'title: Not here\n',
    },
  )
  assert.deepEqual(await listAnalyses(port, '/r/'), [
    { name: 'new', title: 'Newer one', path: '/r/analyses/new', modifiedMs: 30 },
    { name: 'old', title: 'Older one', path: '/r/analyses/old', modifiedMs: 10 },
  ])
})

test('listAnalyses: a file without a title shows its slug; equal times sort by name; no analyses/ gives an empty list', async () => {
  const { port } = fakePort({ '/r/analyses/b': 5, '/r/analyses/a': 5 }, { '/r/analyses/a/analysis.yaml': '', '/r/analyses/b/analysis.yaml': 'title: B\n' })
  assert.deepEqual((await listAnalyses(port, '/r')).map(each => [each.name, each.title]), [['a', 'a'], ['b', 'B']])
  assert.deepEqual(await listAnalyses(fakePort({}).port, '/nowhere'), [])
})

test('createAnalysis derives the slug from the title, writes analysis.yaml, numbers a clash', async () => {
  const { port, files } = fakePort({})
  const first = await createAnalysis(port, '/r', 'Churn in Q3', '2026-11-02')
  assert.deepEqual(first, { name: 'churn-in-q3', title: 'Churn in Q3', path: '/r/analyses/churn-in-q3' })
  assert.equal(files['/r/analyses/churn-in-q3/analysis.yaml'], 'title: Churn in Q3\ncreated: 2026-11-02\n')
  const second = await createAnalysis(port, '/r', 'Churn in Q3!', '2026-11-03')
  assert.equal(second.name, 'churn-in-q3-2')
  assert.equal(files['/r/analyses/churn-in-q3-2/analysis.yaml'], 'title: "Churn in Q3!"\ncreated: 2026-11-03\n')
  assert.equal(files['/r/analyses/churn-in-q3/analysis.yaml'], 'title: Churn in Q3\ncreated: 2026-11-02\n')
})

test('createAnalysis counts a folder without analysis.yaml as taken, and refuses a title with nothing to slug', async () => {
  const { port } = fakePort({ '/r/analyses/old': 1 })
  assert.equal((await createAnalysis(port, '/r', 'Old', '2026-11-02')).name, 'old-2')
  await assert.rejects(createAnalysis(port, '/r', '   ', '2026-11-02'), /title/i)
  await assert.rejects(createAnalysis(port, '/r', '!!!', '2026-11-02'), /title/i)
})

test('openAnalysis reads the title; a folder without analysis.yaml is refused, pointing at the migration', async () => {
  const { port } = fakePort({ '/r/analyses/a': 1, '/r/analyses/b': 1 }, { '/r/analyses/a/analysis.yaml': 'title: A title\n', '/r/analyses/b/.analysis': '' })
  assert.deepEqual(await openAnalysis(port, '/r/analyses/a'), { name: 'a', title: 'A title', path: '/r/analyses/a' })
  await assert.rejects(openAnalysis(port, '/r/analyses/b'), /analysis\.yaml.*migrate:root/s)
})

test('renameAnalysis changes the title and never the folder', async () => {
  const { port, files } = fakePort({ '/r/analyses/a': 1 }, { '/r/analyses/a/analysis.yaml': 'title: Old\nprofile: P\n' })
  assert.deepEqual(await renameAnalysis(port, '/r/analyses/a', ' Better name '), { name: 'a', title: 'Better name', path: '/r/analyses/a' })
  assert.equal(files['/r/analyses/a/analysis.yaml'], 'title: Better name\nprofile: P\n')
  await assert.rejects(renameAnalysis(port, '/r/analyses/a', ' '), /title/i)
})

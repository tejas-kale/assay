import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAnalysis, listAnalyses, validName } from './analyses.ts'
import type { FsPort } from './analyses.ts'

/** An in-memory port: `dirs` maps a folder to its entries' mtimes; `files` holds file paths. */
function fakePort(dirs: Record<string, number>, files: string[] = []) {
  const written = new Map<string, string>()
  const made: string[] = []
  const port: FsPort = {
    readdir: async path => {
      const prefix = `${path}/`
      const names = [...Object.keys(dirs), ...files, ...written.keys()]
        .filter(each => each.startsWith(prefix))
        .map(each => each.slice(prefix.length).split('/')[0] ?? '')
      if (names.length === 0 && !(path in dirs)) throw new Error('ENOENT')
      return [...new Set(names)]
    },
    stat: async path => {
      if (path in dirs) return { isDirectory: true, mtimeMs: dirs[path] ?? 0 }
      if (files.includes(path) || written.has(path)) return { isDirectory: false, mtimeMs: 1 }
      return undefined
    },
    exists: async path => path in dirs || files.includes(path) || written.has(path),
    mkdir: async path => {
      made.push(path)
      dirs[path] = 1
    },
    writeFile: async (path, text) => {
      written.set(path, text)
    },
  }
  return { port, written, made }
}

test('validName follows the mod: letters, digits, dot, underscore, dash; not starting with punctuation', () => {
  for (const ok of ['a', 'Survey-2', 'x.y_z', '9lives']) assert.equal(validName(ok), true, ok)
  for (const bad of ['', '.hidden', '-a', '_a', 'a b', 'a/b', '../x', 'é']) assert.equal(validName(bad), false, bad)
})

test('listAnalyses: analyses/ folders newest first, hidden and plain files skipped', async () => {
  const { port } = fakePort(
    { '/r/analyses': 5, '/r/analyses/old': 10, '/r/analyses/new': 30, '/r/analyses/.git': 99 },
    ['/r/analyses/readme.md'],
  )
  const found = await listAnalyses(port, '/r')
  assert.deepEqual(found, [
    { name: 'new', path: '/r/analyses/new', modifiedMs: 30 },
    { name: 'old', path: '/r/analyses/old', modifiedMs: 10 },
  ])
})

test('listAnalyses: migrated folders count only with a .analysis marker, and keep their parent in the name', async () => {
  const { port } = fakePort(
    { '/r/analyses/a': 10, '/r/investigations/marked': 40, '/r/investigations/bare': 50, '/r/explorations/e': 20 },
    ['/r/investigations/marked/.analysis', '/r/explorations/e/.analysis'],
  )
  const found = await listAnalyses(port, '/r/')
  assert.deepEqual(
    found.map(each => each.name),
    ['investigations/marked', 'explorations/e', 'a'],
  )
  assert.equal(found[0]?.path, '/r/investigations/marked')
})

test('listAnalyses: equal times sort by name; missing parents give an empty list', async () => {
  const { port } = fakePort({ '/r/analyses/b': 5, '/r/analyses/a': 5 })
  assert.deepEqual((await listAnalyses(port, '/r')).map(each => each.name), ['a', 'b'])
  assert.deepEqual(await listAnalyses(fakePort({}).port, '/nowhere'), [])
})

test('createAnalysis makes analyses/<name>/.analysis and nothing else, returning the folder', async () => {
  const { port, written, made } = fakePort({})
  assert.equal(await createAnalysis(port, '/r', 'fresh'), '/r/analyses/fresh')
  assert.deepEqual(made, ['/r/analyses/fresh'])
  assert.deepEqual([...written.keys()], ['/r/analyses/fresh/.analysis'])
  assert.match(written.get('/r/analyses/fresh/.analysis') ?? '', /analysis mod/)
})

test('createAnalysis never overwrites an existing marker, and refuses a bad name', async () => {
  const { port, written } = fakePort({ '/r/analyses/old': 1 }, ['/r/analyses/old/.analysis'])
  assert.equal(await createAnalysis(port, '/r', 'old'), '/r/analyses/old')
  assert.equal(written.size, 0)
  await assert.rejects(createAnalysis(port, '/r', 'a b'), /name/i)
})

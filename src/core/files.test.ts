import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chartPage, defaultOpening, ghosttyArgs, ghosttyTabArgs, isMermaidFile, kindByBytes, kindByName, MAX_FILES, walkFiles } from './files.ts'
import type { WalkPort } from './files.ts'

test('kindByName knows images, text and binary data by extension, and leaves the rest to the bytes', () => {
  assert.equal(kindByName('plots/a.PNG'), 'image')
  assert.equal(kindByName('queries/001_x.sql'), 'text')
  assert.equal(kindByName('data/x.csv'), 'text')
  assert.equal(kindByName('.analysis'), 'text')
  assert.equal(kindByName('notes/flow.mmd'), 'text')
  assert.equal(kindByName('data/emb.npy'), 'other')
  assert.equal(kindByName('Makefile'), undefined)
  assert.equal(kindByName('x.weird'), undefined)
})

test('kindByBytes: a NUL means binary', () => {
  assert.equal(kindByBytes(new TextEncoder().encode('hello\n')), 'text')
  assert.equal(kindByBytes(new Uint8Array([1, 0, 2])), 'other')
})

test('walkFiles lists files newest first and skips tooling folders and .DS_Store', async () => {
  const tree: Record<string, { name: string; isDirectory: boolean; isFile: boolean }[]> = {
    '/a': [
      { name: 'notes.md', isDirectory: false, isFile: true },
      { name: '.DS_Store', isDirectory: false, isFile: true },
      { name: 'queries', isDirectory: true, isFile: false },
      { name: '.venv', isDirectory: true, isFile: false },
      { name: '__pycache__', isDirectory: true, isFile: false },
    ],
    '/a/queries': [{ name: '001_x.sql', isDirectory: false, isFile: true }],
  }
  const mtimes: Record<string, number> = { '/a/notes.md': 1, '/a/queries/001_x.sql': 2 }
  const port: WalkPort = {
    list: async path => tree[path] ?? Promise.reject(new Error('no')),
    stat: path => Promise.resolve(path in mtimes ? { size: 3, mtimeMs: mtimes[path] ?? 0 } : undefined),
  }
  assert.deepEqual(await walkFiles(port, '/a'), [
    { path: 'queries/001_x.sql', size: 3, mtimeMs: 2 },
    { path: 'notes.md', size: 3, mtimeMs: 1 },
  ])
})

test('ghosttyArgs puts -e and its command last', () => {
  const args = ghosttyArgs('/bin/nvim', '/w', '/w/notes.md')
  assert.deepEqual(args.slice(-3), ['-e', '/bin/nvim', '/w/notes.md'])
  assert.ok(args.includes('--working-directory=/w'))
})

test('ghosttyTabArgs passes the quoted command and the folder as arguments, not in the script', () => {
  const args = ghosttyTabArgs("/opt/n vim/nvim", '/w/my analysis', "/w/it's.md")
  assert.deepEqual(args.slice(0, 1), ['-e'])
  assert.deepEqual(args.slice(2), [`'/opt/n vim/nvim' '/w/it'\\''s.md'`, '/w/my analysis'])
  const script = args[1] ?? ''
  assert.ok(!script.includes('/w/') && !script.includes('nvim'))
  assert.match(script, /new tab in front window with configuration cfg/)
  assert.match(script, /new window with configuration cfg/)
})

test('isMermaidFile: .mmd and .mermaid, any case, and nothing else', () => {
  assert.ok(isMermaidFile('notes/flow.mmd'))
  assert.ok(isMermaidFile('Flow.MERMAID'))
  assert.ok(!isMermaidFile('notes/001-flow.md'))
  assert.ok(!isMermaidFile('mmd'))
})

test('chartPage holds the SVG, escapes the title and allows no scripts', () => {
  const page = chartPage('a <b> & "c"', '<svg id="x"></svg>', { bg: '#fff', text: '#000' })
  assert.ok(page.includes('<svg id="x"></svg>'))
  assert.ok(page.includes('<title>a &#60;b&#62; &#38; &#34;c&#34;</title>'))
  assert.ok(page.includes("default-src 'none'"))
  assert.ok(!page.includes('script-src'))
})

test('walkFiles leaves out entries that are neither files nor folders, files that vanish and folders it cannot read, and orders ties by path', async () => {
  const file = (name: string) => ({ name, isDirectory: false, isFile: true })
  const tree: Record<string, { name: string; isDirectory: boolean; isFile: boolean }[]> = {
    '/a': [file('b.txt'), file('a.txt'), file('gone.txt'), { name: 'link', isDirectory: false, isFile: false }, { name: 'locked', isDirectory: true, isFile: false }],
  }
  const port: WalkPort = {
    list: path => (path in tree ? Promise.resolve(tree[path] ?? []) : Promise.reject(new Error('EACCES'))),
    stat: path => Promise.resolve(path.endsWith('gone.txt') ? undefined : { size: 1, mtimeMs: 5 }),
  }
  assert.deepEqual(await walkFiles(port, '/a'), [
    { path: 'a.txt', size: 1, mtimeMs: 5 },
    { path: 'b.txt', size: 1, mtimeMs: 5 },
  ])
})

test('walkFiles stops at MAX_FILES, in the middle of a folder', async () => {
  const entries = Array.from({ length: MAX_FILES + 10 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}`, isDirectory: false, isFile: true }))
  const statted: string[] = []
  const port: WalkPort = {
    list: path => Promise.resolve(path === '/a' ? entries : [{ name: 'later', isDirectory: false, isFile: true }]),
    stat: path => {
      statted.push(path)
      return Promise.resolve({ size: 1, mtimeMs: 1 })
    },
  }
  assert.equal((await walkFiles(port, '/a')).length, MAX_FILES)
  assert.equal(statted.length, MAX_FILES)
})

test('only a document that is not executable opens in its default app; anything else is shown in Finder (audit UI-1)', () => {
  assert.equal(defaultOpening('report.pdf', 0o644), 'default')
  assert.equal(defaultOpening('out/Deck.PPTX', 0o600), 'default')
  for (const [name, mode] of [['report.pdf', 0o755], ['queries/summary', 0o755], ['summary', 0o644], ['x.jar', 0o644], ['x.command', 0o644], ['x.webloc', 0o644], ['x.app', 0o755], ['data.parquet', 0o644], ['.pdf', 0o644]] as const) {
    assert.equal(defaultOpening(name, mode), 'finder', name)
  }
})

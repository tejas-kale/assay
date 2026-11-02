import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ghosttyArgs, kindByBytes, kindByName, walkFiles } from './files.ts'
import type { WalkPort } from './files.ts'

test('kindByName knows images, text and binary data by extension, and leaves the rest to the bytes', () => {
  assert.equal(kindByName('plots/a.PNG'), 'image')
  assert.equal(kindByName('queries/001_x.sql'), 'text')
  assert.equal(kindByName('data/x.csv'), 'text')
  assert.equal(kindByName('.analysis'), 'text')
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
    stat: async path => (path in mtimes ? { size: 3, mtimeMs: mtimes[path] ?? 0 } : undefined),
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

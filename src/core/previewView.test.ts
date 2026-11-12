import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fileSize, previewView } from './previewView.ts'

test('sizes read in bytes, whole KB or MB with a decimal', () => {
  assert.equal(fileSize(0), '0 B')
  assert.equal(fileSize(1023), '1023 B')
  assert.equal(fileSize(1024), '1 KB')
  assert.equal(fileSize(1536), '2 KB')
  assert.equal(fileSize(1024 ** 2 - 1), '1024 KB')
  assert.equal(fileSize(1024 ** 2), '1.0 MB')
  assert.equal(fileSize(5.5 * 1024 ** 2), '5.5 MB')
})

test('a file still being read is reading', () => {
  assert.deepEqual(previewView(undefined, '/a.txt'), { view: 'reading' })
})

test('a failed read shows its message', () => {
  assert.deepEqual(previewView({ ok: false, message: 'gone' }, '/a.txt'), { view: 'error', message: 'gone' })
})

test('an image and a binary file get their own views', () => {
  assert.deepEqual(previewView({ ok: true, kind: 'image', dataUrl: 'data:x' }, '/a.png'), { view: 'image', dataUrl: 'data:x' })
  assert.deepEqual(previewView({ ok: true, kind: 'binary', size: 2048 }, '/a.bin'), { view: 'binary', size: '2 KB' })
})

test('a .mmd or .mermaid file draws a diagram, whatever the case', () => {
  const text = { ok: true, kind: 'text', text: 'graph TD', truncated: false } as const
  assert.deepEqual(previewView(text, '/a.mmd'), { view: 'diagram', text: 'graph TD' })
  assert.deepEqual(previewView(text, '/A.MERMAID'), { view: 'diagram', text: 'graph TD' })
})

test('other text is code, with its truncation; text with no path is code too', () => {
  const cut = { ok: true, kind: 'text', text: 'select 1', truncated: true } as const
  assert.deepEqual(previewView(cut, '/a.sql'), { view: 'code', text: 'select 1', truncated: true })
  assert.deepEqual(previewView(cut, '/a.mmd.txt'), { view: 'code', text: 'select 1', truncated: true })
  assert.deepEqual(previewView({ ...cut, truncated: false }, undefined), { view: 'code', text: 'select 1', truncated: false })
})

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { APP_ENTRY, APP_ORIGIN, mimeType, resolveAppFile } from './appProtocol.ts'

const scratch = mkdtempSync(join(tmpdir(), 'app-protocol-'))
const root = join(scratch, 'renderer')
mkdirSync(join(root, 'assets'), { recursive: true })
writeFileSync(join(root, 'index.html'), '<html></html>')
writeFileSync(join(root, 'assets', 'main.js'), '1')
writeFileSync(join(scratch, 'secret.txt'), 'secret')
symlinkSync(join(scratch, 'secret.txt'), join(root, 'assets', 'link.txt'))
symlinkSync(scratch, join(root, 'up'))
const real = (...parts: string[]) => join(realpathSync(root), ...parts)

test('files inside the renderer folder resolve, and the bare origin is the entry page (audit UI-3)', () => {
  expect(resolveAppFile(root, APP_ENTRY)).toBe(real('index.html'))
  expect(resolveAppFile(root, `${APP_ORIGIN}/`)).toBe(real('index.html'))
  expect(resolveAppFile(root, APP_ORIGIN)).toBe(real('index.html'))
  expect(resolveAppFile(root, `${APP_ORIGIN}/assets/main.js?v=1#x`)).toBe(real('assets', 'main.js'))
})

test('parent folders, encoded or not, are refused', () => {
  for (const path of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
    expect(resolveAppFile(root, APP_ORIGIN + path)).toBeUndefined()
  }
})

test('absolute paths, backslashes, NUL and malformed escapes are refused', () => {
  expect(resolveAppFile(root, `${APP_ORIGIN}//etc/passwd`)).toBeUndefined()
  expect(resolveAppFile(root, `${APP_ORIGIN}/${encodeURIComponent(join(scratch, 'secret.txt'))}`)).toBeUndefined()
  expect(resolveAppFile(root, `${APP_ORIGIN}/assets%5C..%5C..%5Csecret.txt`)).toBeUndefined()
  expect(resolveAppFile(root, `${APP_ORIGIN}/index.html%00.js`)).toBeUndefined()
  expect(resolveAppFile(root, `${APP_ORIGIN}/%E0%A4%A`)).toBeUndefined()
})

test('a symlink that leaves the folder is refused, one that stays is not needed', () => {
  expect(resolveAppFile(root, `${APP_ORIGIN}/assets/link.txt`)).toBeUndefined()
  expect(resolveAppFile(root, `${APP_ORIGIN}/up/secret.txt`)).toBeUndefined()
})

test('another scheme or host, a folder, a missing file and a missing root are refused', () => {
  expect(resolveAppFile(root, `file://${join(root, 'index.html')}`)).toBeUndefined()
  expect(resolveAppFile(root, 'app://evil/index.html')).toBeUndefined()
  expect(resolveAppFile(root, `${APP_ORIGIN}/assets`)).toBeUndefined()
  expect(resolveAppFile(root, `${APP_ORIGIN}/nope.js`)).toBeUndefined()
  expect(resolveAppFile(root, 'not a url')).toBeUndefined()
  expect(resolveAppFile(join(scratch, 'missing'), APP_ENTRY)).toBeUndefined()
})

test('every asset type the renderer loads gets its type; wasm must be application/wasm to compile', () => {
  expect(mimeType('a/index.html')).toBe('text/html; charset=utf-8')
  expect(mimeType('a.JS')).toBe('text/javascript; charset=utf-8')
  expect(mimeType('a.css')).toBe('text/css; charset=utf-8')
  expect(mimeType('ghostty-vt.wasm')).toBe('application/wasm')
  expect(mimeType('a.woff2')).toBe('font/woff2')
  expect(mimeType('a.svg')).toBe('image/svg+xml')
  expect(mimeType('a.png')).toBe('image/png')
  expect(mimeType('a.unknown')).toBe('application/octet-stream')
  expect(mimeType('noext')).toBe('application/octet-stream')
})

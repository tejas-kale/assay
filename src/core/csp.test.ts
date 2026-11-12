import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { CSP_PLACEHOLDER, rendererCsp } from './csp.ts'

const directives = (csp: string) => new Map(csp.split('; ').map(part => [part.split(' ')[0] ?? '', part.split(' ').slice(1)]))

test('the built app runs no inline or evaluated script, and loads no frame, object or form target (audit UI-2)', () => {
  const policy = directives(rendererCsp(false))
  expect(policy.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"])
  for (const name of ['object-src', 'frame-src', 'base-uri', 'form-action']) expect(policy.get(name)).toEqual(["'none'"])
  expect(policy.get('connect-src')).not.toContain('ws:')
})

test('only the dev server allows the refresh preamble and its websocket (audit UI-4)', () => {
  const policy = directives(rendererCsp(true))
  expect(policy.get('script-src')).toContain("'unsafe-inline'")
  expect(policy.get('connect-src')).toContain('ws:')
})

test('index.html takes its policy from the build', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8')
  expect(html).toMatch(`content="${CSP_PLACEHOLDER}"`)
})

test('the built app trusts its app:// origin alone: no file: or other scheme source, no inline script (audit UI-3)', () => {
  const csp = rendererCsp(false)
  expect(csp).not.toMatch('file:')
  expect(csp).not.toMatch('http')
  expect(directives(csp).get('default-src')).toEqual(["'self'"])
  expect(directives(csp).get('script-src')).not.toContain("'unsafe-inline'")
  expect(directives(csp).get('script-src')).not.toContain("'unsafe-eval'")
})

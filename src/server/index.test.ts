// The entry point as Claude Code starts it: the source run by node (the bundled copy is tested in mcp.test.ts).
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { expect } from '../testing/expect.ts'

test('the entry point serves the tools over stdio and ends when stdin closes', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assay-index-'))
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/server/index.ts')], cwd: dir, env: { PATH: process.env.PATH ?? '' } }))
  const { tools } = await client.listTools()
  expect(tools.length).toBeGreaterThan(0)
  await client.close()
})

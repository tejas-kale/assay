import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { expect } from '../testing/expect.ts'
import { serve } from './serve.ts'
import type { Host } from './serve.ts'
import { until } from './testing.ts'

/** A process that only records what the server hooks and how it was told to exit. */
function fakeHost(env: NodeJS.ProcessEnv) {
  const listeners = new Map<string, () => void>()
  const exits: number[] = []
  const host: Host = {
    env,
    stdin: { on: (event, listener) => listeners.set(`stdin ${event}`, listener) },
    on: (event, listener) => listeners.set(event, listener),
    exit: code => exits.push(code),
  }
  return { host, listeners, exits }
}

test("without Assay's environment the session answers that Assay did not start it, and closing ends the process once", async () => {
  const { host, listeners, exits } = fakeHost({})
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const session = await serve(host, serverSide)
  expect(session.assay).toBeUndefined()
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  const result = await client.callTool({ name: 'sql', arguments: { sql: 'SELECT 1', slug: 'x' } })
  expect((result.content as { text: string }[])[0]?.text).toMatch(/^Assay did not start this session/)
  for (const name of ['stdin end', 'SIGTERM', 'SIGINT', 'SIGHUP', 'exit']) expect(listeners.has(name)).toBe(true)
  listeners.get('stdin end')?.()
  listeners.get('SIGTERM')?.()
  expect(exits).toEqual([0])
  listeners.get('exit')?.()
  await client.close()
})

test('with the environment Assay set, the session sets up the analysis, starts its kernel and its requests', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assay-serve-'))
  const analysis = join(dir, 'notes/analyses/a')
  await mkdir(analysis, { recursive: true })
  const { host, listeners } = fakeHost({ ASSAY_ANALYSIS: analysis, ASSAY_ROOT: join(dir, 'notes'), ASSAY_VENV: join(dir, 'no-venv'), TMPDIR: dir })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const session = await serve(host, serverSide)
  await clientSide.start()
  expect(session.assay === undefined).toBe(false)
  expect(await until(() => session.assay?.kernels.current?.state === 'missing')).toBe(true)
  listeners.get('SIGHUP')?.()
  await rm(dir, { recursive: true, force: true })
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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

test('a second session cannot touch an analysis until its first server closes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assay-exclusive-'))
  const analysis = join(dir, 'analyses/a')
  await mkdir(analysis, { recursive: true })
  const env = { ASSAY_ANALYSIS: analysis, ASSAY_ROOT: dir, ASSAY_VENV: join(dir, 'missing') }
  const firstHost = fakeHost(env)
  const [, firstTransport] = InMemoryTransport.createLinkedPair()
  const first = await serve(firstHost.host, firstTransport)
  const [, otherTransport] = InMemoryTransport.createLinkedPair()
  await assert.rejects(serve(fakeHost(env).host, otherTransport), /already has an Assay session/)
  first.close()
  const second = await serve(fakeHost(env).host, otherTransport)
  second.close()
  await rm(dir, { recursive: true, force: true })
})


test('failed startup releases its claim and an old owner cannot remove a replacement claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assay-start-failure-'))
  const analysis = join(dir, 'analyses/a')
  await mkdir(analysis, { recursive: true })
  const env = { ASSAY_ANALYSIS: analysis, ASSAY_ROOT: dir, ASSAY_VENV: join(dir, 'missing') }
  const [, broken] = InMemoryTransport.createLinkedPair()
  broken.start = () => Promise.reject(new Error('transport failed'))
  await assert.rejects(serve(fakeHost(env).host, broken), /transport failed/)
  const [, transport] = InMemoryTransport.createLinkedPair()
  const session = await serve(fakeHost(env).host, transport)
  const lock = join(analysis, '.assay/session.lock')
  await unlink(lock)
  await writeFile(lock, 'replacement')
  session.close()
  session.close()
  assert.equal(await readFile(lock, 'utf8'), 'replacement')
  await rm(dir, { recursive: true, force: true })
})

test('a linked .assay folder is refused before a server writes into it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assay-linked-session-'))
  const analysis = join(dir, 'analysis')
  const outside = join(dir, 'outside')
  await mkdir(analysis)
  await mkdir(outside)
  await symlink(outside, join(analysis, '.assay'))
  const [, transport] = InMemoryTransport.createLinkedPair()
  await assert.rejects(serve(fakeHost({ ASSAY_ANALYSIS: analysis, ASSAY_ROOT: dir, ASSAY_VENV: '/missing' }).host, transport), /not a real folder/)
  await rm(dir, { recursive: true, force: true })
})

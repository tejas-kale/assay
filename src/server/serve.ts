// The life of the bundled server's process: it serves one session over a transport and ends with Claude Code's.
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { configFromEnv, createSession } from './main.ts'
import type { Session } from './main.ts'

/** The part of `process` the server uses, so a test can stand in for it. */
export type Host = {
  env: NodeJS.ProcessEnv
  stdin: { on(event: 'end', listener: () => void): unknown }
  on(event: 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'exit', listener: () => void): unknown
  exit(code: number): unknown
}

/** The server writes its session files in `.assay/`; a linked folder would send them outside the analysis. */
function refuseLinkedSessionFolder(analysis: string) {
  const folder = join(analysis, '.assay')
  mkdirSync(folder, { recursive: true })
  if (!lstatSync(folder).isDirectory()) throw new Error(`${folder} is not a real folder.`)
}

/** Starts the session on `transport` and returns it; the session is closed once, whichever way the process ends. */
export async function serve(host: Host, transport: Transport): Promise<Session> {
  const config = configFromEnv(host.env)
  if (config) refuseLinkedSessionFolder(config.analysis)
  const session = createSession(config)
  let isClosing = false
  const close = () => {
    if (isClosing) return
    isClosing = true
    session.close()
    host.exit(0)
  }
  // The session ends: Claude Code closes stdin or signals the server. The kernel goes with it.
  host.stdin.on('end', close)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) host.on(signal, close)
  host.on('exit', () => {
    session.close()
  })

  // The files first, so the first tool call finds them; the kernel after, so a slow python check never delays the
  // handshake Claude Code waits for.
  try {
    await session.assay?.setUp().catch(() => undefined)
    await session.server.connect(transport)
    await session.assay?.kernels.start().catch(() => undefined)
    session.requests?.start()
    return session
  } catch (error) {
    session.close()
    throw error
  }
}

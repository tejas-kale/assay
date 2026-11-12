// The life of the bundled server's process: it serves one session over a transport and ends with Claude Code's.
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

/** Starts the session on `transport` and returns it; the session is closed once, whichever way the process ends. */
export async function serve(host: Host, transport: Transport): Promise<Session> {
  const session = createSession(configFromEnv(host.env))
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
  await session.assay?.setUp().catch(() => undefined)
  await session.server.connect(transport)
  await session.assay?.kernels.start().catch(() => undefined)
  session.requests?.start()
  return session
}

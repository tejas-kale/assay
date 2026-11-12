// The life of the bundled server's process: it serves one session over a transport and ends with Claude Code's.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { configFromEnv, createSession } from './main.ts'
import type { Config } from './assay.ts'
import type { Session } from './main.ts'

/** The part of `process` the server uses, so a test can stand in for it. */
export type Host = {
  env: NodeJS.ProcessEnv
  stdin: { on(event: 'end', listener: () => void): unknown }
  on(event: 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'exit', listener: () => void): unknown
  exit(code: number): unknown
}

/** An exclusive server claim, independent of launcher PID namespaces. A crash deliberately leaves it for manual recovery. */
function claimAnalysis(analysis: string): () => void {
  const folder = join(analysis, '.assay')
  mkdirSync(folder, { recursive: true })
  if (!lstatSync(folder).isDirectory()) throw new Error(`${folder} is not a real folder.`)
  const path = join(folder, 'session.lock')
  let handle: number
  try {
    handle = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    throw new Error(`${analysis} already has an Assay session or an unrecovered session.lock. Close all its app and terminal sessions first. After a crash, remove ${path} only after every session has stopped.`, { cause: error })
  }
  const owned = fstatSync(handle)
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const current = lstatSync(path, { throwIfNoEntry: false })
      if (current?.ino === owned.ino && current.dev === owned.dev) unlinkSync(path)
    } finally {
      closeSync(handle)
    }
  }
}

function lockedSession(config: Config | undefined): Session {
  const release = config ? claimAnalysis(config.analysis) : () => undefined
  try {
    const session = createSession(config)
    const endSession = session.close
    session.close = () => {
      try { endSession() } finally { release() }
    }
    return session
  } catch (error) {
    release()
    throw error
  }
}

/** Starts the session on `transport`; only one server may own the analysis and its kernel. */
export async function serve(host: Host, transport: Transport): Promise<Session> {
  const session = lockedSession(configFromEnv(host.env))
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

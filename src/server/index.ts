// Entry point of the bundled server (`npm run build:server` → out/server/index.mjs).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { configFromEnv, createSession } from './main.ts'

const session = createSession(configFromEnv(process.env))
let isClosing = false
const close = () => {
  if (isClosing) return
  isClosing = true
  session.close()
  process.exit(0)
}
// The session ends: Claude Code closes stdin or signals the server. The kernel goes with it.
process.stdin.on('end', close)
process.on('SIGTERM', close)
process.on('SIGINT', close)
process.on('SIGHUP', close)
process.on('exit', () => session.close())

// The files first, so the first tool call finds them; the kernel after, so a slow python check never delays the
// handshake Claude Code waits for.
await session.assay?.setUp().catch(() => undefined)
await session.server.connect(new StdioServerTransport())
await session.assay?.kernels.start().catch(() => undefined)
session.requests?.start()

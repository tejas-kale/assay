// The MCP server "assay": one per Claude session, over stdio. Claude Code starts it at session start (from the
// app's --mcp-config, docs/process/launch-contract.md) and ends it at session end; the kernel lives exactly as long.
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { NOT_ASSAY } from '../core/rules.ts'
import { Assay } from './assay.ts'
import { currentCommit } from '../shared/trustedCommit.ts'
import type { Config } from './assay.ts'
import { realProc } from './proc.ts'
import type { Proc } from './proc.ts'
import { Requests } from './requests.ts'
import { callTool, TOOLS } from './tools.ts'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The session's config from the environment Assay set (docs/process/launch-contract.md), or undefined when Assay did
 * not start it. The server sits two folders down from the backend (src/server or out/server), so the kernel runner
 * is ../../python. ASSAY_KERNEL_RUNNER exists for tests.
 */
export function configFromEnv(env: NodeJS.ProcessEnv, proc: Proc = realProc): Config | undefined {
  const { ASSAY_ANALYSIS: analysis, ASSAY_ROOT: root, ASSAY_VENV: venv } = env
  if (!analysis || !root || !venv || ![analysis, root, venv].every(path => isAbsolute(path))) return undefined
  return {
    analysis: resolve(analysis),
    root: resolve(root),
    venv: resolve(venv),
    runner: env.ASSAY_KERNEL_RUNNER || resolve(here, '../../python/analysis_kernel.py'),
    tmp: (env.TMPDIR || tmpdir()).replace(/\/+$/, '') || '/tmp',
    proc,
    currentCommit: name => currentCommit(resolve(root), name),
  }
}

export type Session = { server: Server; assay?: Assay; requests?: Requests; close: () => void }

/** The MCP server for this config; without one every tool answers that Assay did not start the session. */
export function createSession(config: Config | undefined): Session {
  const server = new Server({ name: 'assay', version: '0.1.0' }, { capabilities: { tools: {} } })
  const assay = config ? new Assay(config) : undefined
  const requests = assay ? new Requests(assay) : undefined
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params
    const text = assay ? await callTool(assay, name, args as Record<string, unknown>).catch((error: unknown) => `The ${name} tool failed: ${error instanceof Error ? error.message : String(error)}`) : NOT_ASSAY
    return { content: [{ type: 'text', text }] }
  })
  return {
    server,
    ...(assay ? { assay } : {}),
    ...(requests ? { requests } : {}),
    close: () => {
      requests?.stop()
      assay?.kernels.stop()
    },
  }
}

#!/usr/bin/env node
// The app smoke test's Claude (ASSAY_CLAUDE_BIN). The app runs it as it runs Claude, with `--plugin-dir
// <backend>/plugin` and the ASSAY_* environment (docs/process/launch-contract.md). Like Claude, it starts the plugin's
// MCP server through the SDK's client and keeps it open, so the server answers the app's requests. It ends, closing
// the server, when the app closes the session. The Doctor's probe runs it with --version.
import { join } from 'node:path'
import { setInterval } from 'node:timers'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

if (process.argv.includes('--version')) {
  console.log('0.0.0 (stub Claude)')
  process.exit(0)
}

const pluginDir = process.argv[process.argv.indexOf('--plugin-dir') + 1]
if (!pluginDir || !process.env.ASSAY_ANALYSIS) {
  console.error(`stub claude: started without --plugin-dir or ASSAY_ANALYSIS: ${process.argv.slice(2).join(' ')}`)
  process.exit(2)
}

const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
const client = new Client({ name: 'stub-claude', version: '0' })
await client.connect(new StdioClientTransport({ command: 'node', args: [join(pluginDir, '../out/server/index.mjs')], cwd: process.cwd(), env, stderr: 'inherit' }))
const { tools } = await client.listTools()
console.log(`stub claude: the assay server is up with ${String(tools.length)} tools`)

const end = () => void client.close().finally(() => process.exit(0))
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, end)
// Keeps the process alive, as Claude's own loop would.
setInterval(() => undefined, 60_000)

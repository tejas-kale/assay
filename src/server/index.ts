// Entry point of the bundled server (`npm run build:server` → out/server/index.mjs).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { serve } from './serve.ts'

await serve(process, new StdioServerTransport())

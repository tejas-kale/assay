// Bundles the MCP server and the plugin's hook scripts, each into one ESM file with its dependencies, so the
// container runs them with plain `node` and no `npm install`: out/server/index.mjs and out/hooks/<name>.mjs.
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
  // Some dependencies are CommonJS and call require() on Node built-ins.
  banner: { js: "import { createRequire as __assayRequire } from 'node:module'; const require = __assayRequire(import.meta.url);" },
}

const outdir = process.argv[2] ?? 'out'
await build({ ...common, entryPoints: { index: 'src/server/index.ts' }, outdir: `${outdir}/server`, outExtension: { '.js': '.mjs' } })
await build({
  ...common,
  entryPoints: { prompt: 'src/hooks/prompt.ts', bash: 'src/hooks/bash.ts', write: 'src/hooks/write.ts', state: 'src/hooks/state.ts' },
  outdir: `${outdir}/hooks`,
  outExtension: { '.js': '.mjs' },
})

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await build({ ...common, entryPoints: { assay: 'src/cli/index.ts', 'run-action': 'src/cli/runAction.ts' }, outdir: `${outdir}/cli`,
  outExtension: { '.js': '.mjs' }, define: { ASSAY_VERSION: JSON.stringify(version) } })

await build({ bundle: true, platform: 'neutral', format: 'esm', target: 'es2023',
  entryPoints: ['src/core/conversationBundle.ts'], outfile: 'plugin/hooks/conversation-model.js', logLevel: 'warning' })

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

import { CSP_PLACEHOLDER, rendererCsp } from './src/core/csp.ts'

// The renderer's policy (src/core/csp.ts): the dev server's adds its refresh preamble and websocket.
const csp = (): Plugin => {
  let isDev = false
  return {
    name: 'assay-csp',
    configResolved: config => {
      isDev = config.command === 'serve'
    },
    transformIndexHtml: html => html.replace(CSP_PLACEHOLDER, rendererCsp(isDev)),
  }
}

// Main is ESM (package.json "type": "module") with dependencies external, so node-pty loads
// from node_modules at runtime. Preload is CJS (out/preload/index.cjs) so `sandbox: true` works.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), csp()],
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
})

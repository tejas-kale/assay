import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

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
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
})

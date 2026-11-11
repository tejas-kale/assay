// Builds the server and hooks bundles (as `npm run build:server` does) into a temp folder, once per test file, so
// the tests run what the plugin runs.
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
let built: Promise<string> | undefined

export function bundle(): Promise<string> {
  built ??= (async () => {
    const out = await mkdtemp(join(tmpdir(), 'assay-bundle-'))
    await run(process.execPath, [resolve('scripts/build-server.mjs'), out])
    return out
  })()
  return built
}

/** Runs a script with `node`, the given stdin and environment; its stdout, stderr and exit code. */
export function runNode(script: string, input: string, env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(done => {
    const child = execFile(process.execPath, [script], { env }, (error, stdout, stderr) => {
      done({ code: error ? Number((error as { code?: unknown }).code ?? 1) : 0, stdout, stderr })
    })
    child.stdin?.end(input)
  })
}

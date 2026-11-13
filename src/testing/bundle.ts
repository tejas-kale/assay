// Builds the server and hooks bundles (as `npm run build:server` does) into a temp folder, once per test file, so
// the tests run what the plugin runs.
import { execFile, spawn } from 'node:child_process'
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

/**
 * Runs a script with `node`, the given stdin and environment; its stdout, stderr and exit code. `detached` starts it in
 * a new session, without the controlling terminal the tests may have.
 */
export function runNode(script: string, input: string, env: Record<string, string | undefined>, detached = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script], { env, detached })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', fail)
    child.once('close', code => { done({ code: code ?? 1, stdout, stderr }) })
    child.stdin.end(input)
  })
}

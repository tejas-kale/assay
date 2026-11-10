// The programs Assay runs from the user's PATH, found as a terminal would find them. A GUI app has a thin PATH, so
// the login shell is asked for its environment once per check and the programs run with it.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { parseLoginEnv, parseProbes, probeScript } from '../core/doctor.ts'
import type { LoginEnv, Probes } from '../core/doctor.ts'
import type { UvRun } from './backend.ts'

const run = promisify(execFile)
const SHELL_MS = 15_000
// A cold uv cache downloads every wheel.
const UV_MS = 15 * 60_000

/**
 * The user's login, interactive shell's PATH and launcher (`ASSAY_CLAUDE_BIN`, which a `.zshrc` may set), as the
 * launch sees them. `env` is a program, so the same command works in zsh, bash and fish.
 */
export async function loginEnv(): Promise<LoginEnv & { PATH: string }> {
  const ran = await run(process.env.SHELL || '/bin/zsh', ['-lic', 'env'], { timeout: SHELL_MS }).catch(() => undefined)
  const found = parseLoginEnv(ran?.stdout ?? '')
  const launcher = found.ASSAY_CLAUDE_BIN ?? process.env.ASSAY_CLAUDE_BIN
  return { PATH: found.PATH ?? process.env.PATH ?? '/usr/bin:/bin', ...(launcher ? { ASSAY_CLAUDE_BIN: launcher } : {}) }
}

/** What `command -v` and `--version` say for each tool the Doctor checks, in the login shell's environment. */
export async function probeTools(login: LoginEnv): Promise<Probes> {
  const ran = await run('/bin/sh', ['-c', probeScript()], { env: { ...process.env, ...login }, timeout: SHELL_MS }).catch(
    (error: unknown) => ({ stdout: typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout) : '' }),
  )
  return parseProbes(ran.stdout)
}

/** uv from the login shell's PATH. Its error is the last lines it printed, which name what failed. */
export const uvWith =
  (path: string): UvRun =>
  async (args, env) => {
    try {
      await run('uv', [...args], { env: { ...process.env, PATH: path, ...env }, timeout: UV_MS, maxBuffer: 16 * 1024 * 1024 })
      return {}
    } catch (error) {
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : ''
      return { error: stderr.split('\n').slice(-5).join('\n') || (error instanceof Error ? error.message : String(error)) }
    }
  }

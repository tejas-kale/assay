// The programs Assay runs from the user's PATH, found as a terminal would find them. A GUI app has a thin PATH, so
// the login shell is asked for its PATH once per check and the programs run with it.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { parseProbes, probeScript } from '../core/doctor.ts'
import type { Probes } from '../core/doctor.ts'
import type { UvRun } from './backend.ts'

const run = promisify(execFile)
const SHELL_MS = 15_000
// A cold uv cache downloads every wheel.
const UV_MS = 15 * 60_000

/**
 * The PATH of the user's login, interactive shell. `printenv` is a program, so the same command works in zsh, bash
 * and fish; an interactive shell may print a greeting first, so the PATH is its last line.
 */
export async function loginPath(): Promise<string> {
  const shell = process.env.SHELL || '/bin/zsh'
  const fallback = process.env.PATH ?? '/usr/bin:/bin'
  const ran = await run(shell, ['-lic', 'printenv PATH'], { timeout: SHELL_MS }).catch(() => undefined)
  return ran?.stdout.trim().split('\n').at(-1)?.trim() || fallback
}

/** What `command -v` and `--version` say for each tool the Doctor checks. */
export async function probeTools(path: string): Promise<Probes> {
  const ran = await run('/bin/sh', ['-c', probeScript()], { env: { ...process.env, PATH: path }, timeout: SHELL_MS }).catch(
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

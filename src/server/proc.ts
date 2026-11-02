// How the server runs programs: short runs that it waits for (the Databricks CLI, psql, the helpers, git, a Python
// run's client) and long-lived children it reads as they print (the kernel's serve process, a trust check). Tests
// pass a fake in place of `realProc`.
import { spawn } from 'node:child_process'

export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }
export type RunOptions = { cwd: string; timeoutMs?: number }

/** A child the server reads line by line. `exited` settles with its exit code (null when killed by a signal). */
export type Child = {
  pid: number | undefined
  onOutput(cb: (stream: 'stdout' | 'stderr', text: string) => void): void
  exited: Promise<number | null>
  kill(): void
}

export type Proc = {
  run(argv: readonly string[], options: RunOptions): Promise<RunResult>
  spawn(argv: readonly string[], options: { cwd: string }): Child
}

/** The most stdout a run keeps (as the mod's host did): past it the result is cut and flagged. */
const MAX_STDOUT = 4 * 1024 * 1024

export const realProc: Proc = {
  run(argv, { cwd, timeoutMs }) {
    return new Promise(resolve => {
      const [file = '', ...args] = argv
      let stdout = ''
      let stderr = ''
      let isStdoutTruncated = false
      let settled = false
      const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const finish = (result: RunResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = timeoutMs
        ? setTimeout(() => {
            child.kill('SIGKILL')
            finish({ exitCode: 124, stdout, stderr: `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)} s.`.trim(), isStdoutTruncated })
          }, timeoutMs)
        : undefined
      child.stdout.setEncoding('utf8').on('data', (text: string) => {
        if (stdout.length + text.length > MAX_STDOUT) {
          stdout += text.slice(0, Math.max(0, MAX_STDOUT - stdout.length))
          isStdoutTruncated = true
        } else stdout += text
      })
      child.stderr.setEncoding('utf8').on('data', (text: string) => {
        stderr = (stderr + text).slice(-64_000)
      })
      child.on('error', error => finish({ exitCode: 127, stdout, stderr: error.message, isStdoutTruncated }))
      child.on('close', code => finish({ exitCode: code ?? 1, stdout, stderr, isStdoutTruncated }))
    })
  },

  spawn(argv, { cwd }) {
    const [file = '', ...args] = argv
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const listeners: ((stream: 'stdout' | 'stderr', text: string) => void)[] = []
    child.stdout.setEncoding('utf8').on('data', (text: string) => listeners.forEach(cb => cb('stdout', text)))
    child.stderr.setEncoding('utf8').on('data', (text: string) => listeners.forEach(cb => cb('stderr', text)))
    const exited = new Promise<number | null>(resolve => {
      child.on('error', error => {
        listeners.forEach(cb => cb('stderr', error.message))
        resolve(127)
      })
      child.on('close', code => resolve(code))
    })
    return {
      pid: child.pid,
      onOutput: cb => void listeners.push(cb),
      exited,
      kill: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      },
    }
  },
}

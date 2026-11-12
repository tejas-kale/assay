// realProc against real short programs (node itself, so nothing depends on the machine's tools).
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { realProc } from './proc.ts'

const node = (code: string) => [process.execPath, '-e', code]
const cwd = process.cwd()

test('run returns the exit code, stdout and stderr', async () => {
  const result = await realProc.run(node('console.log("out"); console.error("err"); process.exit(3)'), { cwd })
  expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', isStdoutTruncated: false })
})

test('run writes input to stdin and closes it, or closes it at once without input', async () => {
  const echo = node('process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase()))')
  expect((await realProc.run(echo, { cwd, input: 'abc' })).stdout).toBe('ABC')
  expect((await realProc.run(echo, { cwd })).stdout).toBe('')
})

test('run is cut and flagged when stdout passes the limit, keeping the first 4 MiB', async () => {
  const result = await realProc.run(node('process.stdout.write("x".repeat(5 * 1024 * 1024))'), { cwd })
  expect(result.isStdoutTruncated).toBe(true)
  expect(result.stdout.length).toBe(4 * 1024 * 1024)
})

test('run keeps only the last 64000 characters of stderr', async () => {
  const result = await realProc.run(node('process.stderr.write("a".repeat(70000) + "END")'), { cwd })
  expect(result.stderr.length).toBe(64_000)
  expect(result.stderr.endsWith('END')).toBe(true)
})

test('a program that never reads its stdin is not a crash', async () => {
  const result = await realProc.run(node('process.exit(0)'), { cwd, input: 'y'.repeat(5 * 1024 * 1024) })
  expect(result.exitCode).toBe(0)
})

test('a run past its timeout is killed and answers 124 with what it printed', async () => {
  const result = await realProc.run(node('console.log("began"); console.error("slow"); setInterval(() => undefined, 1000)'), { cwd, timeoutMs: 400 })
  expect(result.exitCode).toBe(124)
  expect(result.stdout).toBe('began\n')
  expect(result.stderr).toBe('slow\n\nTimed out after 0 s.')
})

test('a program that cannot start answers 127 with the reason', async () => {
  const result = await realProc.run(['/no/such/program'], { cwd })
  expect(result.exitCode).toBe(127)
  expect(result.stderr).toMatch(/ENOENT/)
})

test('spawn reports the output of each stream to every listener, then the exit code', async () => {
  const child = realProc.spawn(node('console.log("one"); console.error("two"); process.exit(5)'), { cwd })
  const first: string[] = []
  const second: string[] = []
  child.onOutput((stream, text) => first.push(`${stream}:${text.trim()}`))
  child.onOutput((stream, text) => second.push(`${stream}:${text.trim()}`))
  expect(typeof child.pid).toBe('number')
  expect(await child.exited).toBe(5)
  expect(first).toContain('stderr:two')
  expect(first).toContain('stdout:one')
  expect(first).toHaveLength(2)
  expect(second).toEqual(first)
})

test('spawn of a missing program reports the reason on stderr and exits 127', async () => {
  const child = realProc.spawn(['/no/such/program'], { cwd })
  const seen: string[] = []
  child.onOutput((stream, text) => seen.push(`${stream}:${text}`))
  expect(await child.exited).toBe(127)
  expect(seen[0]).toMatch(/^stderr:.*ENOENT/)
  child.kill()
})

test('kill ends a running child with a signal (null), and does nothing once it has ended', async () => {
  const child = realProc.spawn(node('setInterval(() => undefined, 1000)'), { cwd })
  child.kill()
  expect(await child.exited).toBe(null)
  child.kill()
  const done = realProc.spawn(node('0'), { cwd })
  expect(await done.exited).toBe(0)
  done.kill()
})

test('every Python Assay starts runs without writing bytecode, for run and spawn alike (audit UP-1)', async () => {
  const code = 'process.stdout.write(process.env.PYTHONDONTWRITEBYTECODE ?? "unset")'
  expect((await realProc.run(node(code), { cwd })).stdout).toBe('1')
  const child = realProc.spawn(node(code), { cwd })
  let seen = ''
  child.onOutput((_stream, text) => {
    seen += text
  })
  await child.exited
  expect(seen).toBe('1')
})

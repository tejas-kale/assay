// The four hook scripts imported in-process, with stdin and stdout stood in and the environment set: each reads its
// input, calls its decision and prints the answer. (hooks.test.ts runs the bundled scripts as Claude Code does.)
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BASH_PYTHON_DENY } from '../core/bashGuard.ts'
import { expect } from '../testing/expect.ts'
import { readInput } from './io.ts'

type Printed = { hookSpecificOutput: Record<string, string> }

const setEnv = (key: string, value: string | undefined) => {
  if (value === undefined) Reflect.deleteProperty(process.env, key)
  else process.env[key] = value
}
const parse = (text: string) => JSON.parse(text) as Printed

let imports = 0

type Replaced = { restore(): void; printed(): string }

/** Stands in for process.stdin (one chunk of `input`), process.stdout.write and the given environment variables. */
function standIn(input: string, env: Record<string, string | undefined>): Replaced {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  const write = process.stdout.write.bind(process.stdout)
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  let printed = ''
  Object.defineProperty(process, 'stdin', { configurable: true, value: [input] })
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk)
    return true
  })
  for (const [key, value] of Object.entries(env)) {
    setEnv(key, value)
  }
  return {
    printed: () => printed,
    restore() {
      if (stdin) Object.defineProperty(process, 'stdin', stdin)
      process.stdout.write = write
      for (const [key, value] of Object.entries(before)) {
        setEnv(key, value)
      }
    },
  }
}

async function runScript(name: string, input: string, env: Record<string, string | undefined>): Promise<string> {
  const replaced = standIn(input, env)
  try {
    await import(`./${name}.ts?run=${String(imports++)}`)
  } finally {
    replaced.restore()
  }
  return replaced.printed()
}

const session = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assay-scripts-'))
  const analysis = join(dir, 'root/analyses/panel')
  await mkdir(join(analysis, '.assay'), { recursive: true })
  return { dir, root: join(dir, 'root'), analysis }
}

test('readInput gives the JSON object on stdin, and an empty one for anything else', async () => {
  for (const [text, expected] of [['{"a":1}', { a: 1 }], ['[1]', [1]], ['"x"', {}], ['null', {}], ['not json', {}], ['', {}]] as const) {
    const replaced = standIn(text, {})
    try {
      expect([text, await readInput()]).toEqual([text, expected])
    } finally {
      replaced.restore()
    }
  }
})

test('the bash script prints a refusal in a session and nothing outside one', async () => {
  const input = JSON.stringify({ tool_input: { command: 'python x.py' } })
  const printed = await runScript('bash', input, { ASSAY_ANALYSIS: '/a' })
  expect(parse(printed).hookSpecificOutput.permissionDecisionReason).toBe(BASH_PYTHON_DENY)
  expect(printed.endsWith('\n')).toBe(true)
  expect(await runScript('bash', input, { ASSAY_ANALYSIS: undefined })).toBe('')
})

test('the write script prints a refusal for a guarded path and nothing otherwise', async () => {
  const { root, analysis } = await session()
  const env = { ASSAY_ANALYSIS: analysis, ASSAY_ROOT: root }
  const guarded = await runScript('write', JSON.stringify({ tool_input: { file_path: `${root}/trusted/x.sql` } }), env)
  expect(parse(guarded).hookSpecificOutput.permissionDecision).toBe('deny')
  expect(await runScript('write', JSON.stringify({ tool_input: { file_path: `${analysis}/lib/x.py` } }), env)).toBe('')
})

test('the prompt script prints the rules in a session and nothing outside one', async () => {
  const { root, analysis } = await session()
  const printed = await runScript('prompt', JSON.stringify({ prompt: 'hi' }), { ASSAY_ANALYSIS: analysis, ASSAY_ROOT: root, ASSAY_VENV: undefined })
  expect(parse(printed).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
  expect(await runScript('prompt', '{}', { ASSAY_ANALYSIS: undefined, ASSAY_ROOT: undefined })).toBe('')
})

test('the state script records the state in the analysis, and prints nothing', async () => {
  const { analysis } = await session()
  expect(await runScript('state', JSON.stringify({ hook_event_name: 'Stop' }), { ASSAY_ANALYSIS: analysis })).toBe('')
  expect((JSON.parse(await readFile(join(analysis, '.assay/claude.json'), 'utf8')) as { state: string }).state).toBe('idle')
  await writeFile(join(analysis, '.assay/claude.json'), '')
  expect(await runScript('state', JSON.stringify({ hook_event_name: 'Other' }), { ASSAY_ANALYSIS: analysis })).toBe('')
  expect(await readFile(join(analysis, '.assay/claude.json'), 'utf8')).toBe('')
})

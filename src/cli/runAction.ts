// Invoked only by a rich row's button. Code execution remains in the server: this process only submits requests.
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { canRerun } from '../core/requests.ts'
import { codeBody, parseRunHeader, parseRuns } from '../core/runs.ts'
import { messageOf } from '../main/fsAccess.ts'
import { writeRequest } from '../main/requestFiles.ts'

async function savedRun(analysis: string, file: string) {
  if (file.includes('/') || file.includes('\\')) throw new Error('Name a saved run inside queries.')
  const run = parseRuns([file])[0]
  if (!run?.code || !run.language || run.number <= 0) throw new Error('Name a saved SQL or Python run.')
  const queries = join(await realpath(analysis), 'queries')
  if (!(await lstat(queries)).isDirectory()) throw new Error('queries is not a real folder.')
  const handle = await open(join(queries, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new Error('The saved run is not a regular file.')
    const text = await handle.readFile('utf8')
    const body = codeBody(text, run.language)
    const header = parseRunHeader(text, run.language)
    const reason = canRerun(run, header, body)
    if (reason) throw new Error(reason)
    return { run, body, engine: header.engine }
  } finally {
    await handle.close()
  }
}

async function runEditor(editor: string, path: string): Promise<boolean> {
  // Mods capture process streams; use the controlling terminal for interactive editors when one exists.
  const terminal = await open('/dev/tty', constants.O_RDWR).catch(() => undefined)
  try {
    return await new Promise<boolean>((done, fail) => {
      const stdio: ['inherit', number, number] | [number, number, number] = terminal
        ? [terminal.fd, terminal.fd, terminal.fd] : ['inherit', 2, 2]
      const child = spawn('/bin/sh', ['-c', `${editor} "$1"`, 'assay-editor', path], { stdio })
      child.once('error', fail)
      child.once('exit', code => { done(code === 0) })
    })
  } finally {
    await terminal?.close()
  }
}

async function editedCode(file: string, body: string): Promise<string | undefined> {
  const editor = process.env.EDITOR
  if (!editor?.trim()) throw new Error('Set EDITOR to edit a run.')
  const scratch = await mkdtemp(join(tmpdir(), 'assay-edit-'))
  const path = join(scratch, file)
  try {
    await writeFile(path, body, { flag: 'wx', mode: 0o600 })
    // EDITOR is the person's shell command; the file path is a separate shell argument, never interpolated.
    const success = await runEditor(editor, path)
    if (!success) throw new Error('The editor failed; no run was sent.')
    const changed = await readFile(path, 'utf8')
    return changed === body ? undefined : changed
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof input !== 'object' || input === null) throw new Error('Invalid action.')
  const action: unknown = Reflect.get(input, 'action')
  const file: unknown = Reflect.get(input, 'file')
  if ((action !== 'edit' && action !== 'rerun') || typeof file !== 'string') throw new Error('Invalid action.')
  const analysis = process.env.ASSAY_ANALYSIS
  if (!analysis) throw new Error('ASSAY_ANALYSIS is missing.')
  const saved = await savedRun(analysis, file)
  const body = action === 'edit' ? await editedCode(file, saved.body) : saved.body
  if (body === undefined) return { ok: true, unchanged: true }
  return writeRequest(analysis, saved.run.language === 'python'
    ? { kind: 'python', code: body, from: saved.run.number }
    : { kind: 'sql', sql: body, engine: saved.engine, from: saved.run.number })
}

console.log(JSON.stringify(await main().catch((error: unknown) => ({ ok: false, message: messageOf(error) }))))

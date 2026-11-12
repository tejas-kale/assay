// A scratch analysis for the server's tests, ported from the analysis mod's tests/fake.ts: real files in a temp
// folder, and a scripted `Proc` in place of the programs the server runs. Paths in `files` are from the analysis
// folder; one starting with `/` is from the scratch folder's top, which stands for `/` (so `/opt/venv-assay/bin/python`
// makes venv-assay "built").
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { Assay } from './assay.ts'
import { byCodeUnit } from '../core/nameOrder.ts'
import type { Child, Proc, RunOptions, RunResult } from './proc.ts'
import { Requests } from './requests.ts'

export type Run = (argv: readonly string[], options?: RunOptions) => Partial<RunResult> | Promise<Partial<RunResult>>

/** A spawned process the test drives: what it prints, and how it ends. */
export type Serve = {
  argv: readonly string[]
  cwd: string
  emit: (event: object) => void
  print: (text: string, stream?: 'stdout' | 'stderr') => void
  end: (code?: number | null) => void
  isStopped: boolean
}

export const READY = { event: 'ready', kernel: 'k1', pid: 4242 }
export const RUNNER = '/opt/assay/python/analysis_kernel.py'

export const answering = (rows: string[][], columns: string[]): Run => () => ({
  stdout: JSON.stringify([
    { state: 'SUCCEEDED', columns, rows },
    { state: 'SUCCEEDED', columns: ['1'], rows: [['1']] },
  ]),
})

/** Waits, a few milliseconds at a time, until the condition holds (`ms` at most). */
export async function until(condition: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await condition()) return true
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  return await condition()
}

export type Fake = {
  dir: string
  analysis: string
  root: string
  venv: string
  assay: Assay
  requests: Requests
  runs: (readonly string[])[]
  serves: Serve[]
  /** Whether a serve process says `ready` as soon as it starts (default true). */
  autoReady: boolean
  setRun: (run: Run) => void
  /** A file's text, from the analysis folder (or the scratch top with a leading `/`); undefined when missing. */
  file: (path: string) => Promise<string | undefined>
  put: (path: string, text: string) => Promise<void>
  /** The analysis's files (not .assay/), sorted. */
  list: (under?: string) => Promise<string[]>
  status: () => Promise<{ running: unknown; failed: Record<string, string>; kernel?: { state: string; message?: string } } | null>
  call: (tool: string, args?: Record<string, unknown>) => Promise<string>
  done: () => Promise<void>
}

type Script = { run: Run; autoReady: boolean }

/** A spawned process the test drives, added to `serves`. */
function spawnServe(script: Script, serves: Serve[], argv: readonly string[], cwd: string): Child {
  const listeners: ((stream: 'stdout' | 'stderr', text: string) => void)[] = []
  const { promise: exited, resolve: finish } = Promise.withResolvers<number | null>()
  const serve: Serve = {
    argv,
    cwd,
    emit: event => {
      serve.print(`${JSON.stringify(event)}\n`)
    },
    print: (text, stream = 'stdout') => {
      if (!serve.isStopped) for (const cb of listeners) cb(stream, text)
    },
    end: (code = 0) => {
      if (serve.isStopped) return
      serve.isStopped = true
      finish(code)
    },
    isStopped: false,
  }
  serves.push(serve)
  // The trust checks are driven by the test; only the kernel's serve process starts by itself.
  if (script.autoReady && !argv.includes('--stream')) {
    setTimeout(() => {
      serve.emit(READY)
    }, 0)
  }
  return {
    pid: 1000 + serves.length,
    onOutput: cb => {
      listeners.push(cb)
    },
    exited,
    kill: () => {
      serve.end(null)
    },
  }
}

/** The scripted `Proc`: what ran, and the processes it spawned for the test to drive. */
function scriptedProc() {
  const script: Script = { run: answering([], []), autoReady: true }
  const runs: (readonly string[])[] = []
  const serves: Serve[] = []
  const proc: Proc = {
    async run(argv, options) {
      runs.push(argv)
      if (argv[0] === 'kill') return { exitCode: 0, stdout: '', stderr: '' }
      const ran = await script.run(argv, options)
      return { exitCode: 0, stdout: '', stderr: '', ...ran }
    },
    spawn: (argv, { cwd }) => spawnServe(script, serves, argv, cwd),
  }
  return { script, runs, serves, proc }
}

/** The analysis's files (not .assay/), sorted, under `under`. */
async function listFiles(analysis: string, under: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (at: string) => {
    for (const entry of await readdir(join(analysis, at), { withFileTypes: true }).catch(() => [])) {
      const path = at ? `${at}/${entry.name}` : entry.name
      if (path === '.assay') continue
      if (entry.isDirectory()) await walk(path)
      else found.push(path)
    }
  }
  await walk(under)
  return found.toSorted(byCodeUnit)
}

/** The app's status file (runs.json), or null before there is one. */
async function readStatus(analysis: string): Promise<Awaited<ReturnType<Fake['status']>>> {
  const text = await readFile(join(analysis, '.assay/runs.json'), 'utf8').catch(() => undefined)
  return text === undefined ? null : (JSON.parse(text) as Awaited<ReturnType<Fake['status']>>)
}

/** The scratch folder with the analysis's files written into it. */
async function scratch(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'assay-test-'))
  const analysis = join(dir, 'work/analyses/feature')
  await mkdir(analysis, { recursive: true })
  const pathOf = (path: string) => (path.startsWith('/') ? join(dir, path) : join(analysis, path))
  const put = async (path: string, text: string) => {
    await mkdir(dirname(pathOf(path)), { recursive: true })
    await writeFile(pathOf(path), text, 'utf8')
  }
  for (const [path, text] of Object.entries(files)) await put(path, text)
  return { dir, analysis, root: join(dir, 'work'), venv: join(dir, 'opt/venv-assay'), pathOf, put }
}

export async function fake(files: Record<string, string> = { 'analysis.yaml': 'title: Feature\n' }, options: { currentCommit?: (name: string) => Promise<string | undefined> } = {}): Promise<Fake> {
  const { dir, analysis, root, venv, pathOf, put } = await scratch(files)
  const { script, runs, serves, proc } = scriptedProc()
  const assay = new Assay({ analysis, root, venv, runner: RUNNER, tmp: join(dir, 'tmp'), proc, ...options })
  // The search line on a first run is tested on its own: set `assay.searchHinted = false` to get it.
  assay.searchHinted = true
  const requests = new Requests(assay)
  return {
    dir,
    analysis,
    root,
    venv,
    assay,
    requests,
    runs,
    serves,
    get autoReady() {
      return script.autoReady
    },
    set autoReady(value: boolean) {
      script.autoReady = value
    },
    setRun: next => {
      script.run = next
    },
    file: path => readFile(pathOf(path), 'utf8').catch(() => undefined),
    put,
    list: (under = '') => listFiles(analysis, under),
    status: () => readStatus(analysis),
    call: async (tool, args = {}) => {
      const { callTool } = await import('./tools.ts')
      return callTool(assay, tool, args)
    },
    done: async () => {
      requests.stop()
      assay.kernels.stop()
      for (const serve of serves) serve.end(null)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** A path inside the scratch folder as the test wrote it (`/opt/...`), for comparing argv. */
export const scratchPath = (ws: Fake, path: string) => `/${relative(ws.dir, path)}`

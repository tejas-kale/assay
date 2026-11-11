// The kernel: one `analysis_kernel.py serve` per session. Its stdout events keep `kernel` in runs.json; each Python run
// is a short `analysis_kernel.py run` client against the kernel's connection file (pythonRun.ts).
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { splitKernelEvents, venvCandidates } from '../core/pythonRuns.ts'
import type { KernelEvent, KernelState } from '../core/pythonRuns.ts'
import type { Assay } from './assay.ts'
import type { Child } from './proc.ts'

/** For the prompt hook, which names the kernel's python in the rules. */
export const SESSION = '.assay/session.json'
const KERNEL_READY_MS = 120_000
const READY_TRIES = 3

export type Kernel = {
  generation: number
  state: KernelState
  message?: string
  pid?: number
  python?: string
  connection?: string
  /** Settles once the serve process said ready, dead or missing (or ended). */
  ready: Promise<void>
  markReady: () => void
  stop?: () => void
  /** How many runs are in this kernel now: it is busy while any is. */
  runs: number
}

/** A change to the kernel's state; `message` or `pid` given as undefined is removed. */
export type KernelPatch = { state?: KernelState; message?: string; pid?: number }

const isUp = (kernel: Kernel | undefined) => kernel?.state === 'idle' || kernel?.state === 'busy'

/** The session's kernel: started, watched, replaced and stopped. */
export class KernelHost {
  /** The kernel now, absent until one was ever started. */
  current: Kernel | undefined
  private generations = 0
  private readonly assay: Assay

  constructor(assay: Assay) {
    this.assay = assay
  }

  /** Changes `current`'s state and rewrites runs.json; a kernel that was replaced changes nothing. */
  async update(current: Kernel, patch: KernelPatch) {
    if (this.current !== current) return
    if (patch.state) current.state = patch.state
    if ('message' in patch) {
      if (patch.message === undefined) delete current.message
      else current.message = patch.message
    }
    if ('pid' in patch) {
      if (patch.pid === undefined) delete current.pid
      else current.pid = patch.pid
    }
    await this.assay.rewriteAppStatus()
  }

  /** `work` with `kernel` busy: idle again when the last run in it ends. */
  async whileBusy<T>(kernel: Kernel, work: () => Promise<T>): Promise<T> {
    kernel.runs++
    await this.update(kernel, { state: 'busy' })
    try {
      return await work()
    } finally {
      kernel.runs--
      if (kernel.runs === 0 && kernel.state === 'busy') await this.update(kernel, { state: 'idle' })
    }
  }

  stop() {
    this.current?.stop?.()
    if (this.current) delete this.current.stop
  }

  /** The kernel's python: the nearest project .venv's when it imports ipykernel (checked at each start), else Assay's venv's. */
  async python(): Promise<string | undefined> {
    const { config } = this.assay
    const project = await this.projectPython(config.analysis).catch(() => undefined)
    if (project) {
      const ran = await config.proc.run([project, '-c', 'import ipykernel'], { cwd: config.analysis, timeoutMs: 20_000 }).catch(() => undefined)
      if (ran?.exitCode === 0) return project
    }
    return this.assay.toolsPython()
  }

  /** Starts the kernel, ending any earlier one. Returns once the serve process is spawned (or known missing). */
  async start() {
    this.stop()
    let markReady: () => void = () => undefined
    const ready = new Promise<void>(resolve => {
      markReady = resolve
    })
    const current: Kernel = { generation: ++this.generations, state: 'starting', ready, markReady, runs: 0 }
    this.current = current
    await this.assay.rewriteAppStatus()
    const python = await this.python()
    if (this.current === current && python) current.python = python
    await this.assay.writeAtomic(SESSION, `${JSON.stringify({ python: python ?? null })}\n`).catch(() => undefined)
    if (!python) {
      await this.update(current, { state: 'missing', message: await this.assay.venvHint() })
      current.markReady()
      return
    }
    // A newer start replaced this one while it was looking around.
    if (this.current !== current) return
    this.spawn(current, python)
  }

  /** Waits until the kernel has answered. A serve that never says ready is stopped and the kernel is dead. */
  async settled(readyMs = KERNEL_READY_MS) {
    for (let i = 0; i < READY_TRIES && this.current; i++) {
      const current = this.current
      if ((await readyWithin(current, readyMs)) === 'late') {
        current.stop?.()
        await this.update(current, { state: 'dead', message: `The kernel did not start within ${String(readyMs / 1000)} s.` })
        current.markReady()
      }
      if (this.current === current) break
    }
  }

  /** The kernel made ready for a run, starting a new one if it died or was missing; or why there is none. */
  async ready(): Promise<{ problem?: string; note?: string }> {
    const before = this.current
    const note = before?.state === 'dead' ? 'The kernel had died: this run is in a new kernel, so earlier variables are gone.' : undefined
    if (!before || before.state === 'dead' || before.state === 'missing') await this.start()
    await this.settled()
    const kernel = this.current
    if (kernel?.state === 'missing') return { problem: `The Python kernel is not available: ${kernel.message ?? 'missing'}` }
    if (!isUp(kernel)) return { problem: `The Python kernel is not running: ${kernel?.message ?? kernel?.state ?? 'not started'}` }
    return note ? { note } : {}
  }

  /** Interrupts the run in the kernel (SIGUSR1 to its serve process); why not, if it cannot. */
  async interrupt(): Promise<string | undefined> {
    const current = this.current
    if (!current?.pid || !isUp(current)) return 'No kernel is running.'
    const { config } = this.assay
    const ran = await config.proc
      .run(['kill', '-USR1', String(current.pid)], { cwd: config.analysis })
      .catch((error: unknown) => ({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }))
    return ran.exitCode === 0 ? undefined : ran.stderr.trim() || 'The kernel could not be interrupted.'
  }

  /** A new kernel in place of this one; why not, if it did not come up. */
  async restart(): Promise<string | undefined> {
    await this.start()
    await this.settled()
    return isUp(this.current) ? undefined : (this.current?.message ?? 'The kernel did not start.')
  }

  private spawn(current: Kernel, python: string) {
    const { config } = this.assay
    const connection = join(config.tmp, `assay-kernel-${String(Date.now())}-${randomBytes(3).toString('hex')}.json`)
    current.connection = connection
    const child = config.proc.spawn([python, config.runner, 'serve', '--analysis', config.analysis, '--connection', connection], { cwd: config.analysis })
    current.stop = () => {
      child.kill()
    }
    void this.supervise(current, child)
  }

  /** The nearest project .venv/bin/python from `dir` up, if any. Only the kernel may use it. */
  private async projectPython(dir: string): Promise<string | undefined> {
    for (const candidate of venvCandidates(dir)) if (await this.assay.exists(candidate)) return candidate
    return undefined
  }

  private async apply(current: Kernel, event: KernelEvent) {
    if (event.event === 'ready') {
      await this.update(current, { state: current.runs > 0 ? 'busy' : 'idle', message: undefined, pid: event.pid })
      current.markReady()
    } else if (event.event === 'dead' || event.event === 'missing') {
      await this.update(current, { state: event.event, message: event.message })
      current.markReady()
    }
  }

  /** The serve process's life: its events, applied in order, and its end. */
  private async supervise(current: Kernel, child: Child) {
    const heard = { buffer: '', stderr: '', stopped: false, applying: Promise.resolve() }
    child.onOutput((stream, text) => {
      if (this.current !== current) return
      if (stream === 'stderr') {
        heard.stderr = (heard.stderr + text).slice(-2000)
        return
      }
      const parsed = splitKernelEvents(heard.buffer + text)
      heard.buffer = parsed.rest
      for (const event of parsed.events) {
        if (event.event === 'stopped') heard.stopped = true
        heard.applying = heard.applying.then(() => this.apply(current, event))
      }
    })
    const code = await child.exited
    await heard.applying
    current.markReady()
    if (this.current !== current || heard.stopped || current.state === 'dead' || current.state === 'missing') return
    const why = heard.stderr.trim().split('\n').slice(-3).join(' ') || endedWith(code)
    await this.update(current, { state: code === 2 ? 'missing' : 'dead', message: why })
  }
}

function endedWith(code: number | null) {
  return code === null ? 'The kernel process ended.' : `The kernel process ended (exit ${String(code)}).`
}

/** Whether `current` said ready (or dead, or missing) within `ms`. */
async function readyWithin(current: Kernel, ms: number): Promise<'ready' | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>(resolve => {
    timer = setTimeout(() => {
      resolve('late')
    }, ms)
  })
  const outcome = await Promise.race([current.ready.then(() => 'ready' as const), late])
  clearTimeout(timer)
  return outcome
}

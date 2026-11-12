// A Python run: saved under the next number, run by `analysis_kernel.py run` in the session's kernel, recorded.
import { formatPythonRun, parsePythonRun, runSlug } from '../core/pythonRuns.ts'
import type { PythonRun } from '../core/pythonRuns.ts'
import { message, QUERIES } from './assay.ts'
import type { Assay } from './assay.ts'
import type { Kernel } from './kernel.ts'

const PYTHON_TIMEOUT_MS = 600_000
const PYTHON_TIMEOUT_S = 590
/** The runner's exit when it could not reach the kernel; it still prints a summary and saves an error .json. */
const UNREACHABLE = 3

export type PythonOutcome = { text: string; number?: number; status?: PythonRun['status'] }

/** A kernel with all a run needs. */
type Live = { kernel: Kernel; python: string; connection: string; pid: number }

/** One Python run after those before it: Claude's reply, the run's number and its status. */
export function runPython(assay: Assay, code: string, slugText: string, header: string) {
  return assay.inKernel(() => runPythonNow(assay, code, slugText, header))
}

/** One Python run in the kernel as it stands (the caller holds the queue): saved, run, recorded; Claude's reply. */
export async function runPythonNow(assay: Assay, code: string, slugText: string, header: string): Promise<PythonOutcome> {
  const prepared = await assay.kernels.ready()
  if (prepared.problem) return { text: prepared.problem }
  const found = liveKernel(assay.kernels.current)
  if ('lacks' in found) return { text: `The Python kernel is not running: it has no ${found.lacks}.` }
  const { live } = found
  const note = prepared.note ? `${prepared.note}\n` : ''
  const made: { number?: number; status?: PythonRun['status'] } = {}
  const text = await assay.runQuery({
    slug: runSlug(slugText),
    saved: `${header}${code.trim()}\n`,
    ext: 'py',
    noun: 'Run',
    hasTables: false,
    onClaim: claimed => {
      made.number = claimed
    },
    run: (file, claimed) => {
      const startedAt = Date.now()
      return assay.kernels.whileBusy(live.kernel, async () => {
        const parsed = await runFile(assay, live, file)
        if (!('status' in parsed)) return parsed
        made.status = parsed.status
        return { reply: note + formatPythonRun(claimed, parsed, Date.now() - startedAt, { queriesDir: assay.shown(QUERIES) }) }
      })
    },
  })
  // The number is claimed before the run starts.
  return { text, number: made.number, ...(made.status ? { status: made.status } : {}) }
}

/** The kernel with its python, connection file and pid; else which of them it lacks. */
function liveKernel(kernel: Kernel | undefined): { live: Live } | { lacks: string } {
  if (!kernel) return { lacks: 'process' }
  const { python, connection, pid } = kernel
  if (!python) return { lacks: 'python' }
  if (!connection) return { lacks: 'connection file' }
  if (!pid) return { lacks: 'pid' }
  return { live: { kernel, python, connection, pid } }
}

/** Runs the saved file in the kernel: what the runner printed, or why it failed. */
async function runFile(assay: Assay, live: Live, file: string): Promise<PythonRun | { error: string }> {
  const { config } = assay
  const argv = [
    live.python, config.runner, 'run', '--connection', live.connection, '--analysis', config.analysis, '--code-file', file,
    '--timeout', String(PYTHON_TIMEOUT_S), '--serve-pid', String(live.pid),
  ]
  const ran = await config.proc
    .run(argv, { cwd: config.analysis, timeoutMs: PYTHON_TIMEOUT_MS })
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: message(error) }))
  const said = (ran.stderr.trim() || ran.stdout.trim() || `The kernel runner exited with ${String(ran.exitCode)}.`).split('\n').slice(-5).join('\n')
  const parsed = ran.exitCode === 0 || ran.exitCode === UNREACHABLE ? parsePythonRun(ran.stdout) : { error: said }
  if (ran.exitCode === UNREACHABLE) {
    const why = ('status' in parsed ? parsed.error?.message : parsed.error) || said
    await assay.kernels.update(live.kernel, { state: 'dead', message: why })
  }
  return parsed
}

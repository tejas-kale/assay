// The helper's streamed checks: `analysis_trust check ... --stream` runs as a child, and each event it prints goes to
// the review as it arrives.
import { splitCheckEvents } from '../core/calculations.ts'
import type { CheckEvent } from '../core/calculations.ts'
import { HELPER_PYTHON_FLAGS } from '../core/helperFlags.ts'
import type { Assay } from './assay.ts'
import { QUERY_TIMEOUT_MS } from './sqlRun.ts'
import type { Review } from './trustReview.ts'

type Stream = {
  /** The stdout so far that is not yet a whole line. */
  buffer: string
  /** The last 2000 characters the helper printed to stderr. */
  stderr: string
  failure: string | undefined
  isDone: boolean
  isTimedOut: boolean
}

type Take = (event: CheckEvent) => string | undefined

/** The helper's arguments: a calculation is checked in its folder, a dictionary entry by its file. */
const checkArgs = (review: Review, analysis: string) =>
  review.kind === 'calculation' ? ['check', review.folder, review.name, analysis, '--stream'] : ['check-entry', `${review.folder}/${review.name}.yaml`, analysis, '--stream']

/** Gives the events to the review; `done` is the last of them, and the helper's error is kept. Whether `done` came. */
function feed(stream: Stream, events: readonly CheckEvent[], take: Take): boolean {
  for (const event of events) {
    if (stream.isDone) break
    if (event.event === 'done') stream.isDone = true
    stream.failure = take(event) ?? stream.failure
  }
  return stream.isDone
}

/** Why the checks did not finish, or undefined when they did. */
function unfinished(stream: Stream, exitCode: number | null): string | undefined {
  if (stream.failure) return stream.failure
  if (stream.isDone) return undefined
  if (stream.isTimedOut) return `The checks took more than ${String(QUERY_TIMEOUT_MS / 60_000)} minutes and were stopped.`
  return (stream.stderr.trim() || `analysis_trust exited with ${String(exitCode)}`).split('\n').slice(-3).join(' ')
}

/** Runs the helper's checks, streamed, into `take`. Returns why it could not, or undefined when it finished. */
export async function streamChecks(assay: Assay, review: Review, take: Take): Promise<string | undefined> {
  const python = await assay.toolsPython()
  if (!python) return assay.venvHint()
  const analysis = assay.config.analysis
  const child = assay.config.proc.spawn([python, ...HELPER_PYTHON_FLAGS, '-m', 'analysis_trust', ...checkArgs(review, analysis)], { cwd: analysis })
  const stream: Stream = { buffer: '', stderr: '', failure: undefined, isDone: false, isTimedOut: false }
  const timer = setTimeout(() => {
    stream.isTimedOut = true
    child.kill()
  }, QUERY_TIMEOUT_MS)
  // The timer alone never keeps the server alive.
  timer.unref()
  child.onOutput((from, text) => {
    if (stream.isDone) return
    if (from === 'stderr') {
      stream.stderr = (stream.stderr + text).slice(-2000)
      return
    }
    const parsed = splitCheckEvents(stream.buffer + text)
    stream.buffer = parsed.rest
    // `done` is the last line: the process is over for this review, however it ends.
    if (feed(stream, parsed.events, take)) child.kill()
  })
  const exitCode = await child.exited
  clearTimeout(timer)
  if (!stream.isDone && stream.buffer.trim()) feed(stream, splitCheckEvents(`${stream.buffer}\n`).events, take)
  return unfinished(stream, exitCode)
}

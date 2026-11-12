// The Steps tab's requests (specs/slices/slice-9.md): which runs were asked about, which requests wait for a reply, and what to do
// when a reply, a refusal or the no-reply timeout comes. Pure: the tab keeps the timers and makes the `window.app` calls.

/** No reply is expected after this long: the server only polls while Claude's session is alive. */
export const PICKUP_MS = 10_000
export const NO_REPLY = "No reply: Steps needs Claude's session running."

export type StepsRequests = {
  /** Runs asked about in this window: a run is asked once (`r` asks again). */
  readonly asked: ReadonlySet<number>
  /** Request id to the run it asked about; the data pane leaves the replies to these ids to the tab. */
  readonly pending: ReadonlyMap<string, number>
}

export const noRequests: StepsRequests = { asked: new Set(), pending: new Map() }

/** What to send for a run the tab needs (`needed`, from `stepsRequest`), if it has not asked yet. */
export function nextRequest(state: StepsRequests, run: number, needed: 'steps' | 'lineage' | undefined): 'steps' | 'lineage' | undefined {
  return needed && !state.asked.has(run) ? needed : undefined
}

/** A request for the run is on its way (or `r` asks again): no other is sent for it meanwhile. */
export function asking(state: StepsRequests, run: number): StepsRequests {
  return { ...state, asked: new Set(state.asked).add(run) }
}

/** The request was refused: the run may be asked about again. */
export function refused(state: StepsRequests, run: number): StepsRequests {
  const asked = new Set(state.asked)
  asked.delete(run)
  return { ...state, asked }
}

/** The request was accepted under `id`. */
export function accepted(state: StepsRequests, id: string, run: number): StepsRequests {
  return { ...state, pending: new Map(state.pending).set(id, run) }
}

export type ReplyOutcome =
  | { state: StepsRequests; do: 'ignore' }
  | { state: StepsRequests; do: 'reload'; run: number }
  | { state: StepsRequests; do: { toast: string }; run: number }

/** A reply to a request: not ours is ignored, an error is shown and lets the run be asked again, else the run is read. */
export function replied(state: StepsRequests, id: string, reply: { error: string } | object): ReplyOutcome {
  const run = state.pending.get(id)
  if (run === undefined) return { state, do: 'ignore' }
  const pending = new Map(state.pending)
  pending.delete(id)
  if ('error' in reply && typeof reply.error === 'string') return { state: refused({ ...state, pending }, run), do: { toast: reply.error }, run }
  return { state: { ...state, pending }, do: 'reload', run }
}

/**
 * PICKUP_MS passed. Silence is no file at all by then: a long run writes its file at once and is not silent, so a run
 * with a lineage or steps file keeps waiting. A silent run is asked again on the next visit.
 */
export function pickupTimedOut(state: StepsRequests, id: string, haveFile: boolean): { state: StepsRequests; silent?: number } {
  const run = state.pending.get(id)
  if (run === undefined || haveFile) return { state }
  const pending = new Map(state.pending)
  pending.delete(id)
  return { state: refused({ ...state, pending }, run), silent: run }
}

// The Steps tab's data: what arrived after the run was read, the requests for what is missing, and a selected step's rows.
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { RefObject } from 'react'

import type { LineageFile } from '../../../core/lineage.ts'
import { stepsRequest } from '../../../core/lineage.ts'
import type { Table } from '../../../core/runs.ts'
import type { Step, StepsFile } from '../../../core/steps.ts'
import { accepted, asking, nextRequest, pickupTimedOut, PICKUP_MS, refused, replied } from '../../../core/stepsRequests.ts'
import type { Run, RunView } from '../../../shared/ipc.ts'
import { readStore, update } from './stepsStore.ts'

type Fresh = { number: number; lineage?: LineageFile; steps?: StepsFile }
type Timers = Map<string, ReturnType<typeof setTimeout>>

/** Reads run `number` again, for the lineage and steps files a reply says are there now. */
function reloadRun(number: number, setFresh: (fresh: Fresh) => void) {
  void window.app.readRun(number).then(read => {
    if (read) setFresh({ number, ...(read.lineage && { lineage: read.lineage }), ...(read.steps && { steps: read.steps }) })
  })
}

/** Sends a `steps` or `lineage` request for a run, and watches for the session picking it up. */
function sendRequest(kind: 'steps' | 'lineage', number: number, ctx: { timers: Timers; haveFile: () => boolean; onToast: (text: string) => void; onSilent: (run: number) => void }) {
  update(state => asking(state, number))
  void window.app.runs.request({ kind, run: number }).then(result => {
    if (!result.ok) {
      update(state => refused(state, number))
      ctx.onToast(result.message)
      return
    }
    update(state => accepted(state, result.id, number))
    ctx.timers.set(
      result.id,
      setTimeout(() => {
        const timed = pickupTimedOut(readStore(), result.id, ctx.haveFile())
        update(() => timed.state)
        if (timed.silent !== undefined) ctx.onSilent(timed.silent)
      }, PICKUP_MS),
    )
  })
}

/** Our requests' replies: a reply to ask again about shows its error; any other means the run's files are there to read. */
function useReplies(timers: RefObject<Timers>, setFresh: (fresh: Fresh) => void, onToast: (text: string) => void) {
  const handleReply = useEffectEvent((reply: { id: string }) => {
    const outcome = replied(readStore(), reply.id, reply)
    update(() => outcome.state)
    if (outcome.do === 'ignore') return
    clearTimeout(timers.current.get(reply.id))
    if (outcome.do === 'reload') reloadRun(outcome.run, setFresh)
    else onToast(outcome.do.toast)
  })
  useEffect(() => {
    const stop = window.app.runs.onReply(reply => {
      handleReply(reply)
    })
    const pending = timers.current
    return () => {
      stop()
      pending.forEach(clearTimeout)
    }
  }, [timers])
}

export function useStepsData(run: Run, view: RunView | undefined, onToast: (text: string) => void) {
  // What arrived after the view was read, until the next state push brings it in the view.
  const [fresh, setFresh] = useState<Fresh>()
  const [silent, setSilent] = useState<number>()
  const timers = useRef<Timers>(new Map())
  const here = fresh?.number === run.number ? fresh : undefined
  const lineage = view?.lineage ?? here?.lineage
  const plan = view?.steps ?? here?.steps
  const seen = useRef(false)
  useEffect(() => {
    seen.current = Boolean(lineage ?? plan)
  })

  useReplies(timers, setFresh, onToast)

  const send = (kind: 'steps' | 'lineage') => {
    sendRequest(kind, run.number, { timers: timers.current, haveFile: () => seen.current, onToast, onSilent: setSilent })
  }
  const needed = view ? stepsRequest(run, view.code, lineage, plan) : undefined
  const sendNeeded = useEffectEvent(() => {
    const kind = nextRequest(readStore(), run.number, needed)
    if (kind) send(kind)
  })
  useEffect(() => {
    sendNeeded()
  }, [needed, run.number])

  return { lineage, plan, silent: silent === run.number, send }
}

/** The selected step's rows, read again when it finishes. */
export function useStepTable(runNumber: number, step: Step | undefined): Table | undefined {
  const [loaded, setLoaded] = useState<{ number: number; k: number; table?: Table }>()
  const k = step?.k
  const status = step?.status
  useEffect(() => {
    if (k === undefined || status !== 'ok') return
    let live = true
    void window.app.readRun(runNumber, { step: k }).then(read => {
      if (live) setLoaded({ number: runNumber, k, ...(read?.stepTable && { table: read.stepTable }) })
    })
    return () => {
      live = false
      setLoaded(undefined)
    }
  }, [runNumber, k, status])
  return loaded?.number === runNumber && loaded.k === k ? loaded.table : undefined
}

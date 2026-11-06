// The Steps tab (docs/slice-9.md, slice 9b): the current SQL run's CTE graph. The server reads the SQL with sqlglot
// (only Claude's container has it) and saves `queries/NNN.lineage.json`; this tab asks once per run and draws what it finds.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { lineageMermaid, stepsView } from '../../core/lineage.ts'
import type { LineageFile } from '../../core/lineage.ts'
import { codeBody } from '../../core/runs.ts'
import type { Run, RunView } from '../../shared/ipc.ts'
import { isPaneKey } from './common.tsx'
import { MermaidDiagram } from './Mermaid.tsx'

/** The ids of the requests this tab sent, with the run each asked about: the data pane leaves their replies to it. */
export const lineageRequests = new Map<string, number>()
/** Runs asked about in this window: a run is asked once. */
const asked = new Set<number>()

/** No reply is expected after this long: the server only polls while Claude's session is alive. */
const PICKUP_MS = 10_000
export const NO_REPLY = "No reply: Steps needs Claude's session running."

type Props = {
  header: ReactNode
  view: RunView | undefined
  run: Run
  onToast: (text: string) => void
  onCode: () => void
  onPin: () => void
  onStep: (delta: 1 | -1) => void
}

export function StepsTab({ header, view, run, onToast, onCode, onPin, onStep }: Props) {
  // A lineage that arrived after the view was read, until the next state push brings it in the view.
  const [fresh, setFresh] = useState<{ number: number; lineage: LineageFile }>()
  const [silent, setSilent] = useState<number>()
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const lineage: LineageFile | undefined = view?.lineage ?? (fresh?.number === run.number ? fresh.lineage : undefined)
  const shown = view ? stepsView(run, view.code, lineage) : undefined

  useEffect(() => {
    const stop = window.app.runs.onReply(reply => {
      const number = lineageRequests.get(reply.id)
      if (number === undefined) return
      lineageRequests.delete(reply.id)
      clearTimeout(timers.current.get(reply.id))
      if ('error' in reply) {
        asked.delete(number)
        onToast(reply.error)
      } else void window.app.readRun(number).then(read => read?.lineage && setFresh({ number, lineage: read.lineage }))
    })
    return () => {
      stop()
      timers.current.forEach(clearTimeout)
    }
  }, [onToast])

  const needed = shown?.kind === 'reading'
  useEffect(() => {
    if (!needed || asked.has(run.number)) return
    asked.add(run.number)
    void window.app.runs.request({ kind: 'lineage', run: run.number }).then(result => {
      if (!result.ok) {
        asked.delete(run.number)
        return onToast(result.message)
      }
      lineageRequests.set(result.id, run.number)
      timers.current.set(
        result.id,
        setTimeout(() => {
          lineageRequests.delete(result.id)
          asked.delete(run.number)
          setSilent(run.number)
        }, PICKUP_MS),
      )
    })
  }, [needed, run.number, onToast])

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    if (e.key === 'c') onCode()
    else if (e.key === 'p') onPin()
    else if (e.key === ',' || e.key === '.') onStep(e.key === '.' ? 1 : -1)
    else return
    e.preventDefault()
  }

  let body: ReactNode = null
  if (view?.error) body = <div className="status warn">{view.error}</div>
  else if (shown?.kind === 'message')
    body = (
      <div className="run-body">
        {shown.note && <div className="empty dim">{shown.note}</div>}
        <div className="empty">{shown.text}</div>
      </div>
    )
  else if (shown?.kind === 'reading') body = <div className="empty">{silent === run.number ? NO_REPLY : 'Reading the query…'}</div>
  else if (shown?.kind === 'error')
    body = (
      <>
        <div className="status warn">{shown.error}</div>
        <pre className="run-body code">{codeBody(view?.code ?? '', 'sql')}</pre>
      </>
    )
  else if (shown?.kind === 'diagram')
    body = (
      <div className="run-body">
        {shown.note && <div className="empty dim">{shown.note}</div>}
        <MermaidDiagram text={lineageMermaid(shown.lineage)} />
      </div>
    )

  return (
    <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      {header}
      {body}
    </div>
  )
}

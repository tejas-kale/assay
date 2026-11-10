// The Steps tab (docs/slice-9.md, slices 9b and 9c): the current SQL run's CTE graph, and each CTE run on its own. The
// server reads the SQL with sqlglot (only Claude's container has it), runs the steps and saves `queries/NNN.lineage.json`,
// `NNN.steps.json` and each step's rows; this tab asks once per run, draws what it finds and shows the selected step.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { lineageMermaid, stepsRequest, stepsView } from '../../core/lineage.ts'
import type { LineageFile } from '../../core/lineage.ts'
import { codeBody } from '../../core/runs.ts'
import type { Table } from '../../core/runs.ts'
import { moveStep, uncheckedLines } from '../../core/steps.ts'
import type { Step, StepsFile } from '../../core/steps.ts'
import { accepted, asking, nextRequest, NO_REPLY, noRequests, pickupTimedOut, PICKUP_MS, refused, replied } from '../../core/stepsRequests.ts'
import type { StepsRequests } from '../../core/stepsRequests.ts'
import { THEMES } from '../../core/theme.ts'
import type { ThemeMode } from '../../core/theme.ts'
import type { Run, RunView } from '../../shared/ipc.ts'
import { currentMode, onModeChange } from '../appearance.ts'
import { isPaneKey } from './common.tsx'
import { MermaidDiagram } from './Mermaid.tsx'

// What was asked and what waits for a reply is the window's, not one mount's: the tab unmounts when the user leaves it
// and must not ask again on the next visit, and the data pane has to know which replies are ours. So it lives here, in
// one store only `update` writes; the decisions are in core/stepsRequests.ts.
let store: StepsRequests = noRequests
const update = (change: (state: StepsRequests) => StepsRequests) => {
  store = change(store)
}
/** Whether the request with this id is the tab's: the data pane leaves its reply to it. */
export const isStepsRequest = (id: string) => store.pending.has(id)

type Props = {
  header: ReactNode
  view: RunView | undefined
  run: Run
  onToast: (text: string) => void
  onCode: () => void
  onPin: () => void
  onStep: (delta: 1 | -1) => void
}

const STATUS_TEXT: Record<Step['status'], string> = { pending: 'waiting', running: 'running', ok: 'ok', error: 'failed', skipped: 'skipped' }

export function StepsTab({ header, view, run, onToast, onCode, onPin, onStep }: Props) {
  // What arrived after the view was read, until the next state push brings it in the view.
  const [fresh, setFresh] = useState<{ number: number; lineage?: LineageFile; steps?: StepsFile }>()
  const [silent, setSilent] = useState<number>()
  const [selected, setSelected] = useState(1)
  const [stepTable, setStepTable] = useState<{ number: number; k: number; table?: Table }>()
  const [mode, setMode] = useState<ThemeMode>(currentMode)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const seen = useRef<{ lineage?: LineageFile; steps?: StepsFile }>({})
  const here = fresh?.number === run.number ? fresh : undefined
  const lineage: LineageFile | undefined = view?.lineage ?? here?.lineage
  const plan: StepsFile | undefined = view?.steps ?? here?.steps
  seen.current = { ...(lineage && { lineage }), ...(plan && { steps: plan }) }
  const shown = view ? stepsView(run, view.code, lineage, plan) : undefined
  const steps = shown?.kind === 'diagram' ? (shown.plan?.steps ?? []) : []
  const step = steps.find(each => each.k === selected) ?? steps[0]
  const running = plan?.status === 'running'

  useEffect(() => onModeChange(setMode), [])
  useEffect(() => setSelected(1), [run.number])

  const reload = (number: number) => {
    void window.app.readRun(number).then(read => read && setFresh({ number, ...(read.lineage && { lineage: read.lineage }), ...(read.steps && { steps: read.steps }) }))
  }

  useEffect(() => {
    const stop = window.app.runs.onReply(reply => {
      const outcome = replied(store, reply.id, reply)
      store = outcome.state
      if (outcome.do === 'ignore') return
      clearTimeout(timers.current.get(reply.id))
      if (outcome.do === 'reload') reload(outcome.run)
      else onToast(outcome.do.toast)
    })
    const pending = timers.current
    return () => {
      stop()
      pending.forEach(clearTimeout)
    }
  }, [onToast])

  const send = (kind: 'steps' | 'lineage', number: number) => {
    update(state => asking(state, number))
    void window.app.runs.request({ kind, run: number }).then(result => {
      if (!result.ok) {
        update(state => refused(state, number))
        return onToast(result.message)
      }
      update(state => accepted(state, result.id, number))
      timers.current.set(
        result.id,
        setTimeout(() => {
          const timed = pickupTimedOut(store, result.id, Boolean(seen.current.lineage || seen.current.steps))
          store = timed.state
          if (timed.silent !== undefined) setSilent(timed.silent)
        }, PICKUP_MS),
      )
    })
  }

  const needed = view ? stepsRequest(run, view.code, lineage, plan) : undefined
  useEffect(() => {
    const kind = nextRequest(store, run.number, needed)
    if (kind) send(kind, run.number)
  }, [needed, run.number])

  // The selected step's rows, read again when it finishes.
  const stepKey = `${run.number}:${step?.k ?? 0}:${step?.status ?? ''}`
  useEffect(() => {
    if (!step || step.status !== 'ok') return setStepTable(undefined)
    let live = true
    void window.app.readRun(run.number, { step: step.k }).then(read => live && setStepTable({ number: run.number, k: step.k, ...(read?.stepTable && { table: read.stepTable }) }))
    return () => {
      live = false
    }
  }, [stepKey])

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    if (e.key === 'c') onCode()
    else if (e.key === 'p') onPin()
    else if (e.key === ',' || e.key === '.') onStep(e.key === '.' ? 1 : -1)
    else if ((e.key === 'j' || e.key === 'k') && steps.length > 0) setSelected(moveStep(step?.k ?? 1, e.key === 'j' ? 1 : -1, steps.length))
    else if (e.key === 'r' && shown?.kind === 'diagram' && !running && stepsRequest(run, view?.code, undefined, undefined)) send('steps', run.number)
    else return
    e.preventDefault()
  }

  const colors = THEMES[mode].ui
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
        <MermaidDiagram
          text={lineageMermaid(shown.lineage, shown.marks, { good: colors.good, bad: colors.bad, dim: colors.dim })}
          onNodeClick={node => {
            const clicked = steps.find(each => each.node === node)
            if (clicked) setSelected(clicked.k)
          }}
        />
        {step && <StepDetail step={step} count={steps.length} table={stepTable?.number === run.number && stepTable.k === step.k ? stepTable.table : undefined} />}
      </div>
    )

  return (
    <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      {header}
      {body}
    </div>
  )
}

/** The selected step: its status line, its check lines and its first rows. */
function StepDetail({ step, count, table }: { step: Step; count: number; table: Table | undefined }) {
  const lines = [...(step.checks ?? []), ...uncheckedLines(step)]
  return (
    <div className="step-detail">
      <div>
        step {step.k} of {count}: <b>{step.name}</b>
        {step.block && <span className="chip chip-trusted">{`block ${step.block}`}</span>} <span className="dim">· {STATUS_TEXT[step.status]}</span>
        {step.rows !== undefined && <span className="dim"> · {step.rows} {step.rows === 1 ? 'row' : 'rows'}</span>}
      </div>
      {step.error && <pre className="status warn">{step.error}</pre>}
      {lines.map((check, i) => (
        <div key={i} className={check.kind === 'unchecked' ? 'dim' : check.ok ? 'check-ok' : 'check-bad'}>
          {check.kind === 'unchecked' ? '·' : check.ok ? '✓' : '✗'} {check.text}
        </div>
      ))}
      {table && (
        <table className="grid">
          <thead>
            <tr>
              {table.columns.map((name, c) => (
                <th key={c}>{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, 50).map((row, r) => (
              <tr key={r}>
                {table.columns.map((_, c) => (
                  <td key={c}>{(row[c] ?? '').split('\n')[0]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

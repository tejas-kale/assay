// The Steps tab (specs/slices/slice-9.md, slices 9b and 9c): the current SQL run's CTE graph, and each CTE run on its own. The
// server reads the SQL with sqlglot (only Claude's container has it), runs the steps and saves `queries/NNN.lineage.json`,
// `NNN.steps.json` and each step's rows; this tab asks once per run, draws what it finds and shows the selected step.
import { useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { lineageMermaid, stepsRequest, stepsView } from '../../core/lineage.ts'
import type { StepsView } from '../../core/lineage.ts'
import { codeBody } from '../../core/runs.ts'
import type { Table } from '../../core/runs.ts'
import { moveStep, uncheckedLines } from '../../core/steps.ts'
import type { Step } from '../../core/steps.ts'
import { NO_REPLY } from '../../core/stepsRequests.ts'
import { checkLine, rowsLabel, STATUS_TEXT, stepsKey } from '../../core/stepsTab.ts'
import { THEMES } from '../../core/theme.ts'
import type { ThemeMode } from '../../core/theme.ts'
import type { Run, RunView } from '../../shared/ipc.ts'
import { currentMode, onModeChange } from '../appearance.ts'
import { isPaneKey } from './common.tsx'
import { MermaidDiagram } from './Mermaid.tsx'
import { useStepsData, useStepTable } from './steps/stepsData.ts'
import { isStepsRequest } from './steps/stepsStore.ts'

export { isStepsRequest }

type Props = Readonly<{
  header: ReactNode
  view: RunView | undefined
  run: Run
  onToast: (text: string) => void
  onCode: () => void
  onPin: () => void
  onStep: (delta: 1 | -1) => void
}>

/** The selected step: its status line, its check lines and its first rows. */
function StepDetail({ step, count, table }: Readonly<{ step: Step; count: number; table: Table | undefined }>) {
  const lines = [...(step.checks ?? []), ...uncheckedLines(step)]
  return (
    <div className="step-detail">
      <div>
        step {step.k} of {count}: <b>{step.name}</b>
        {step.block && <span className="chip chip-trusted">{`block ${step.block}`}</span>} <span className="dim">· {STATUS_TEXT[step.status]}</span>
        {step.rows !== undefined && <span className="dim"> · {rowsLabel(step.rows)}</span>}
      </div>
      {step.error && <pre className="status warn">{step.error}</pre>}
      {lines.map((check, i) => {
        const { className, mark } = checkLine(check)
        return (
          <div key={i} className={className}>
            {mark} {check.text}
          </div>
        )
      })}
      {table && <StepRows table={table} />}
    </div>
  )
}

function StepRows({ table }: Readonly<{ table: Table }>) {
  return (
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
  )
}

type DiagramShown = Extract<StepsView, { kind: 'diagram' }>

function Diagram(props: Readonly<{ shown: DiagramShown; mode: ThemeMode; steps: Step[]; step: Step | undefined; table: Table | undefined; onSelect: (k: number) => void }>) {
  const { shown, steps, step } = props
  const colors = THEMES[props.mode].ui
  return (
    <div className="run-body">
      {shown.note && <div className="empty dim">{shown.note}</div>}
      <MermaidDiagram
        text={lineageMermaid(shown.lineage, shown.marks, { good: colors.good, bad: colors.bad, dim: colors.dim })}
        onNodeClick={node => {
          const clicked = steps.find(each => each.node === node)
          if (clicked) props.onSelect(clicked.k)
        }}
      />
      {step && <StepDetail step={step} count={steps.length} table={props.table} />}
    </div>
  )
}

function Message({ shown }: Readonly<{ shown: Extract<StepsView, { kind: 'message' }> }>) {
  return (
    <div className="run-body">
      {shown.note && <div className="empty dim">{shown.note}</div>}
      <div className="empty">{shown.text}</div>
    </div>
  )
}

type BodyProps = Readonly<{ view: RunView | undefined; shown: StepsView | undefined; silent: boolean; diagram: Omit<Parameters<typeof Diagram>[0], 'shown'> }>

function StepsBody({ view, shown, silent, diagram }: BodyProps) {
  if (view?.error) return <div className="status warn">{view.error}</div>
  if (shown?.kind === 'message') return <Message shown={shown} />
  if (shown?.kind === 'reading') return <div className="empty">{silent ? NO_REPLY : 'Reading the query…'}</div>
  if (shown?.kind === 'error') {
    return (
      <>
        <div className="status warn">{shown.error}</div>
        <pre className="run-body code">{codeBody(view?.code ?? '', 'sql')}</pre>
      </>
    )
  }
  if (shown?.kind === 'diagram') return <Diagram shown={shown} {...diagram} />
  return null
}

/** The step selected in the shown run; showing another run starts it on its first step. */
function useSelectedStep(runNumber: number) {
  const [chosen, setChosen] = useState({ number: runNumber, k: 1 })
  if (chosen.number !== runNumber) setChosen({ number: runNumber, k: 1 })
  const selected = chosen.number === runNumber ? chosen.k : 1
  return [selected, (k: number) => { setChosen({ number: runNumber, k }) }] as const
}

export function StepsTab({ header, view, run, onToast, onCode, onPin, onStep }: Props) {
  const [selected, setSelected] = useSelectedStep(run.number)
  const [mode, setMode] = useState<ThemeMode>(currentMode)
  const { lineage, plan, silent, send } = useStepsData(run, view, onToast)
  const shown = view ? stepsView(run, view.code, lineage, plan) : undefined
  const steps = shown?.kind === 'diagram' ? (shown.plan?.steps ?? []) : []
  const step = steps.find(each => each.k === selected) ?? steps[0]
  const table = useStepTable(run.number, step)
  useEffect(() => onModeChange(setMode), [])

  const mayRerun = shown?.kind === 'diagram' && plan?.status !== 'running' && stepsRequest(run, view?.code, undefined, undefined) !== undefined

  function onKeyDown(e: KeyboardEvent) {
    const key = isPaneKey(e) ? stepsKey(e.key) : undefined
    if (key === undefined) return
    if (key === 'code') onCode()
    else if (key === 'pin') onPin()
    else if (key === 'previousRun') onStep(-1)
    else if (key === 'nextRun') onStep(1)
    else if (key === 'rerun' && mayRerun) send('steps')
    else if ((key === 'down' || key === 'up') && steps.length > 0) setSelected(moveStep(step?.k ?? 1, key === 'down' ? 1 : -1, steps.length))
    else return
    e.preventDefault()
  }

  return (
    <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      {header}
      <StepsBody view={view} shown={shown} silent={silent} diagram={{ mode, steps, step, table, onSelect: setSelected }} />
    </div>
  )
}

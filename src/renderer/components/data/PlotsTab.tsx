import { useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { plotKey } from '../../../core/dataPane.ts'
import type { Run } from '../../../shared/ipc.ts'
import { isPaneKey } from '../common.tsx'
import { doRunKey } from './DataTab.tsx'
import type { RunActions } from './RunHeader.tsx'

/** A plot file as read: its data URL, or why it could not be read. */
type Shown = { file: string; url?: string; message?: string }

export type PlotsTabProps = Readonly<{
  header: ReactNode
  run: Run
  runs: Run[]
  plot: number
  onPlot: (delta: 1 | -1) => void
  actions: RunActions
}>

/** The current run's plots, one at a time and fit to the pane. `j` and `k` move between them. */
export function PlotsTab({ header, run, runs, plot, onPlot, actions }: PlotsTabProps) {
  const file = run.plots[plot - 1]
  const shown = usePlot(run, plot, runs)
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    const delta = plotKey(e.key)
    if (delta !== undefined) onPlot(delta)
    if (delta !== undefined || doRunKey(e.key, actions)) e.preventDefault()
  }
  return (
    <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      {header}
      <PlotBody run={run} plot={plot} file={file} shown={shown?.file === file ? shown : undefined} />
    </div>
  )
}

/** The plot's file read; a plot that could not be read yet is tried again on each state push, a read one is not. */
function usePlot(run: Run, plot: number, runs: Run[]): Shown | undefined {
  const file = run.plots[plot - 1]
  const [shown, setShown] = useState<Shown>()
  const failed = shown !== undefined && shown.file === file && shown.url === undefined
  const retry = failed ? runs : null
  useEffect(() => {
    if (file === undefined) return
    let live = true
    void window.app.readPlot(run.number, plot).then(result => {
      if (live) setShown(result.ok ? { file, url: result.dataUrl } : { file, message: result.message })
    })
    return () => {
      live = false
    }
  }, [run.number, plot, file, retry])
  return shown
}

function PlotBody({ run, plot, file, shown }: Readonly<{ run: Run; plot: number; file: string | undefined; shown: Shown | undefined }>) {
  if (run.language !== 'python') return <div className="empty">SQL runs have no plots.</div>
  if (file === undefined) return <div className="empty">Run {run.label} has no plots.</div>
  if (shown?.url) {
    return (
      <div className="plot-frame">
        <img src={shown.url} alt={`Plot ${String(plot)} of run ${run.label}`} />
      </div>
    )
  }
  if (shown) return <div className="status warn">{shown.message}</div>
  return <div className="empty">Loading the plot…</div>
}

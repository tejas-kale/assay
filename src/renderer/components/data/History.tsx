import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { historyKey, runFiles } from '../../../core/dataPane.ts'
import type { Run, RunStatus } from '../../../shared/ipc.ts'
import { isPaneKey } from '../common.tsx'
import { Placeholder, RunTags } from './RunHeader.tsx'

export type HistoryProps = Readonly<{
  runs: Run[]
  status: RunStatus
  current: Run | undefined
  onChoose: (run: Run) => void
  onPin: () => void
}>

/** Every run, newest first: j/k move, g/G the ends, Enter shows the run in Data, p pins. */
export function History({ runs, status, current, onChoose, onPin }: HistoryProps) {
  const newest = [...runs].reverse()
  const [selected, setSelected] = useState(() => Math.max(0, newest.findIndex(r => r.number === current?.number)))
  const index = Math.max(0, Math.min(selected, newest.length - 1))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    const action = historyKey(e.key, index, newest.length)
    if (action?.kind === 'select') setSelected(action.index)
    else if (action?.kind === 'pin') onPin()
    else if (action?.kind === 'choose') {
      const run = newest[index]
      if (run) onChoose(run)
    }
    if (action) e.preventDefault()
  }

  if (newest.length === 0) return <Placeholder text="No runs yet." />
  return (
    <div className="list" ref={ref} tabIndex={-1} data-focus-target onKeyDown={onKeyDown} role="listbox" aria-label="Runs">
      {newest.map((run, i) => (
        <HistoryRow key={run.number} run={run} status={status} selected={i === index} current={run.number === current?.number} onChoose={onChoose} />
      ))}
    </div>
  )
}

function HistoryRow(props: Readonly<{ run: Run; status: RunStatus; selected: boolean; current: boolean; onChoose: (run: Run) => void }>) {
  const { run } = props
  return (
    <div
      role="option"
      aria-selected={props.selected}
      className={props.selected ? 'row sel' : 'row'}
      onMouseDown={e => {
        e.preventDefault()
      }}
      onClick={() => {
        props.onChoose(run)
      }}
    >
      <b className="run-number">{run.label}</b>
      <span className="grow">{run.slug}</span>
      <RunTags run={run} status={props.status} />
      {props.current && <span className="dim">current</span>}
      <span className="dim">{runFiles(run)}</span>
    </div>
  )
}

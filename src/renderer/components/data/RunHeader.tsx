import type { ReactNode } from 'react'

import { runNumber } from '../../../core/dataPane.ts'
import { runLabel } from '../../../core/runs.ts'
import type { RunHeader as Header } from '../../../core/runs.ts'
import type { Run, RunStatus } from '../../../shared/ipc.ts'
import { isPaneKey } from '../common.tsx'

/** The header a run's fields were read from. */
export const headerOf = (run: Run): Header => ({
  author: run.author ?? 'claude',
  engine: run.engine ?? 'databricks',
  ...(run.from !== undefined && { from: run.from }),
  ...(run.replay !== undefined && { replay: run.replay }),
  ...(run.trusted !== undefined && { trusted: run.trusted }),
})

/** The keys every run tab shares, as actions. */
export type RunActions = { onCode: () => void; onPin: () => void; onStep: (delta: 1 | -1) => void }

/** onKey returns true for a key it used, so the key's own text does not land in the editor it may have opened. */
export const Placeholder = ({ text, onKey }: Readonly<{ text: string; onKey?: (key: string) => boolean }>) => (
  <div
    className="list placeholder"
    tabIndex={-1}
    data-focus-target
    onKeyDown={e => {
      if (onKey && isPaneKey(e) && onKey(e.key)) e.preventDefault()
    }}
  >
    <div className="empty">{text}</div>
  </div>
)

/** The Code tab's header while a new query is open: no run yet, only where it will run. */
export function NewQueryHeader({ engine }: Readonly<{ engine: string }>) {
  return (
    <div className="run-header">
      <b>new</b>
      <span className="grow run-slug">SQL query</span>
      <span className="dim">{engine}</span>
      <span className="editing-flag">⌘↩ run · Esc leave</span>
    </div>
  )
}

export function LinkButton({ onClick, label, shortcut }: Readonly<{ onClick: () => void; label: string; shortcut: string }>) {
  return (
    <button type="button" className="run-link" tabIndex={-1} onClick={onClick}>
      {label} → <span className="dim">{shortcut}</span>
    </button>
  )
}

/** The trust label as the chip Notes uses, then `you` and `from 012` when they apply. */
export function RunTags({ run, status }: Readonly<{ run: Run; status: RunStatus }>) {
  const label = runLabel(run, headerOf(run), status)
  return (
    <>
      <span className={`chip chip-${label}`}>{label}</span>
      {run.author === 'user' && <span className="chip chip-you">you</span>}
      {run.from !== undefined && <span className="dim">from {runNumber(run.from)}</span>}
      {run.replay !== undefined && <span className="dim">replay of {runNumber(run.replay)}</span>}
    </>
  )
}

export function RunHeader(
  props: Readonly<{
    run: Run
    status: RunStatus
    pinned: boolean
    editing: boolean
    onFollow: () => void
    /** Earlier (-1) or later (+1) run; undefined while editing. */
    onStep: ((delta: 1 | -1) => void) | undefined
    children: ReactNode
  }>,
) {
  const step = props.onStep
  return (
    <div className="run-header">
      {step && (
        <button type="button" className="run-link run-step" tabIndex={-1} onClick={() => { step(-1) }} title="Earlier run (,)">
          ‹
        </button>
      )}
      <b>{props.run.label}</b>
      {step && (
        <button type="button" className="run-link run-step" tabIndex={-1} onClick={() => { step(1) }} title="Later run (.)">
          ›
        </button>
      )}
      <span className="grow run-slug">{props.run.slug}</span>
      <RunTags run={props.run} status={props.status} />
      {props.editing && <span className="editing-flag">editing {props.run.label}</span>}
      {props.pinned && !props.editing && (
        <button type="button" className="run-link" tabIndex={-1} onClick={props.onFollow} title="Follow Claude's latest run">
          pinned · p: follow latest
        </button>
      )}
      {props.children}
    </div>
  )
}

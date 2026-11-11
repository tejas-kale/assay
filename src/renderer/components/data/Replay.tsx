import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'

import { runNumber } from '../../../core/dataPane.ts'
import { chosenRuns, confirmText } from '../../../core/replay.ts'
import type { ReplayState } from '../../../core/replay.ts'

/** Every key but a shortcut goes to `onKey`, and nowhere else. */
const takeKeys = (onKey: (key: string) => void) => (e: KeyboardEvent) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  e.preventDefault()
  onKey(e.key)
}

/** One line that holds the keys until answered: y, n or Escape. */
export function Prompt({ text, onKey }: Readonly<{ text: string; onKey: (key: string) => void }>) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <div className="status warn" ref={ref} tabIndex={-1} data-focus-target onKeyDown={takeKeys(onKey)}>
      {text}
    </div>
  )
}

/** The Replay view: Python runs oldest first, with a cursor and check marks. The keys are in core/replay.ts. */
export function ReplayView({ state, onKey }: Readonly<{ state: ReplayState; onKey: (key: string) => void }>) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [state.cursor])
  const n = chosenRuns(state).length
  return (
    <div className="list" ref={ref} tabIndex={-1} data-focus-target role="listbox" aria-label="Replay" onKeyDown={takeKeys(onKey)}>
      {state.mode === 'confirm' ? (
        <div className="status warn">{confirmText(state)}</div>
      ) : (
        <div className="status replay-state">
          Replay: {n} of {state.runs.length} chosen · space choose · a all/none · Enter replay · Esc leave
        </div>
      )}
      {state.runs.map((run, i) => (
        <div key={run.number} role="option" aria-selected={i === state.cursor} className={i === state.cursor ? 'row sel' : 'row'}>
          <span>{state.chosen.has(run.number) ? '[x]' : '[ ]'}</span>
          <b className="run-number">{run.label}</b>
          <span className="grow">{run.slug}</span>
          {run.status && run.status !== 'ok' && <span className="chip chip-unverified">{run.status}</span>}
          {run.replay !== undefined && <span className="dim">replay of {runNumber(run.replay)}</span>}
        </div>
      ))}
    </div>
  )
}

// The Replay view: pick Python runs, confirm, send. Pure; the pane draws the state and acts on the effect.
import type { Run } from './runs.ts'

export type ReplayRun = Pick<Run, 'number' | 'label' | 'slug' | 'status' | 'replay'>

export type ReplayState = {
  /** Oldest first. */
  runs: ReplayRun[]
  cursor: number
  chosen: ReadonlySet<number>
  mode: 'pick' | 'confirm'
}

export type ReplayEffect = { type: 'send'; runs: number[] } | { type: 'leave' }

/** Starts with the runs that finished ok and are not themselves replays chosen. */
export function initReplay(runs: readonly ReplayRun[]): ReplayState {
  const sorted = [...runs].sort((a, b) => a.number - b.number)
  const chosen = new Set(sorted.filter(r => r.status === 'ok' && r.replay === undefined).map(r => r.number))
  return { runs: sorted, cursor: 0, chosen, mode: 'pick' }
}

/** The chosen run numbers, oldest first. */
export const chosenRuns = (state: ReplayState): number[] => state.runs.filter(r => state.chosen.has(r.number)).map(r => r.number)

export function confirmText(state: ReplayState): string {
  const n = chosenRuns(state).length
  return `Replay ${String(n)} ${n === 1 ? 'run' : 'runs'} in a new kernel? y / n`
}

export function replayKey(state: ReplayState, key: string): { state: ReplayState; effect?: ReplayEffect } {
  if (state.mode === 'confirm') {
    if (key === 'y') return { state, effect: { type: 'send', runs: chosenRuns(state) } }
    if (key === 'n' || key === 'Escape') return { state: { ...state, mode: 'pick' } }
    return { state }
  }
  const last = Math.max(0, state.runs.length - 1)
  const move = (cursor: number) => ({ state: { ...state, cursor: Math.max(0, Math.min(cursor, last)) } })
  switch (key) {
    case 'j':
    case 'ArrowDown':
      return move(state.cursor + 1)
    case 'k':
    case 'ArrowUp':
      return move(state.cursor - 1)
    case ' ': {
      const run = state.runs[state.cursor]
      if (!run) return { state }
      const chosen = new Set(state.chosen)
      if (!chosen.delete(run.number)) chosen.add(run.number)
      return { state: { ...state, chosen } }
    }
    case 'a':
      return { state: { ...state, chosen: state.chosen.size === state.runs.length ? new Set() : new Set(state.runs.map(r => r.number)) } }
    case 'Enter':
      return state.chosen.size > 0 ? { state: { ...state, mode: 'confirm' } } : { state }
    case 'Escape':
      return { state, effect: { type: 'leave' } }
    default:
      return { state }
  }
}

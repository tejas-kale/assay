// What the data pane shows: the current run (Claude's latest, unless one is held), its table and plot, the tab markers
// and the run's files as read.

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { clampTo } from '../../../core/dataPane.ts'
import { markTabs } from '../../../core/tabs.ts'
import type { Seen, TabIdIn } from '../../../core/tabs.ts'
import type { Run, RunView } from '../../../shared/ipc.ts'

/** Puts the keyboard back on the data pane's current target (after a prompt or a view went away). */
export const focusDataPane = () =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-pane="data"] [data-focus-target]')?.focus())

/** Whether nothing has the keys: focus fell to the page when what had it went away. */
const focusIsLost = () => document.activeElement === document.body || document.activeElement === null

/** What every part of the pane may do: show a tab, or say something in a toast. */
export type PaneActions = { onTab: (tab: TabIdIn<'data'>) => void; onToast: (text: string) => void }

export type HeldRun = {
  current: Run | undefined
  following: boolean
  /** Set when stepping, so the keys come back to the pane once the run is shown. */
  steppedRef: RefObject<boolean>
  choose: (run: Run) => void
  follow: () => void
  stepRun: (delta: 1 | -1) => void
  togglePin: () => void
}

/**
 * The run the pane shows: Claude's latest, unless one is held (chosen in History, or pinned with `p`). A held run
 * that disappears falls back to following. While `locked` (an edit open in Code keeps its own run, and Vim owns the
 * keys) stepping and pinning do nothing.
 */
export function useHeldRun(at: PaneActions & { runs: Run[]; locked: boolean }): HeldRun {
  const { runs, locked } = at
  const [held, setHeld] = useState<number>()
  const steppedRef = useRef(false)
  const latest = runs.at(-1)
  const heldRun = runs.find(r => r.number === held)
  const current = heldRun ?? latest
  // The newest run follows Claude again, as in History.
  const hold = (number: number | undefined) => {
    setHeld(number === latest?.number ? undefined : number)
  }
  const stepRun = (delta: 1 | -1) => {
    if (locked || !current) return
    const next = nextRun(runs, current, delta)
    if (typeof next === 'string') {
      at.onToast(next)
    } else {
      steppedRef.current = true
      hold(next.number)
    }
  }
  return {
    current,
    following: heldRun === undefined,
    steppedRef,
    choose: run => {
      hold(run.number)
      at.onTab('data')
    },
    follow: () => {
      setHeld(undefined)
    },
    stepRun,
    togglePin: () => {
      if (!locked) setHeld(heldRun === undefined ? current?.number : undefined)
    },
  }
}

/** The run before or after `current`, or what to say at either end. */
function nextRun(runs: Run[], current: Run, delta: 1 | -1): Run | string {
  const next = runs[runs.findIndex(r => r.number === current.number) + delta]
  return next ?? (delta < 0 ? 'This is the first run.' : 'This is the latest run.')
}

/**
 * While the next run loads, the Code tab shows nothing and its focused editor goes, dropping focus to the page: once
 * the run is shown, the keys come back to the pane, unless the user moved them elsewhere.
 */
export function useFocusAfterStep(view: RunView | undefined, steppedRef: RefObject<boolean>) {
  useEffect(() => {
    if (!view || !steppedRef.current) return
    steppedRef.current = false
    if (focusIsLost()) focusDataPane()
  }, [view, steppedRef])
}

/** The current run's table and plot, and whether a Python run shows its text: each run starts at its first. */
export type RunPicks = {
  python: boolean
  table: { k: number; count: number; textView: boolean; toggleText: () => void; step: (delta: 1 | -1) => void }
  plot: { n: number; count: number; step: (delta: 1 | -1) => void }
}

type Picks = { run: number | undefined; table: number; plot: number; text?: boolean }

export function useRunPicks(current: Run | undefined): RunPicks {
  const number = current?.number
  const fresh: Picks = { run: number, table: 1, plot: 1 }
  const [picks, setPicks] = useState<Picks>(fresh)
  // Another run starts afresh, and coming back to this one does too.
  if (picks.run !== number) setPicks(fresh)
  const change = (made: Partial<Picks>) => {
    // A change made for a run no longer shown is dropped.
    setPicks(before => (before.run === number ? { ...before, ...made } : before))
  }
  const python = current?.language === 'python'
  const tables = current?.tables.length ?? 0
  const plots = current?.plots.length ?? 0
  const k = clampTo(picks.table, tables)
  const n = clampTo(picks.plot, plots)
  // A Python run with no table opens on its text: stdout and the error.
  const textView = python && (picks.text ?? tables === 0)
  return {
    python,
    table: {
      k,
      count: tables,
      textView,
      toggleText: () => { change({ text: !textView }) },
      step: delta => { change({ table: clampTo(k + delta, tables) }) },
    },
    plot: { n, count: plots, step: delta => { change({ plot: clampTo(n + delta, plots) }) } },
  }
}

/** The tabs marked "new since you looked": what changed in `seen` since the last state push, away from `tab`. */
export function useMarkers(seen: Seen, tab: TabIdIn<'data'>): ReadonlySet<string> {
  const [markers, setMarkers] = useState<ReadonlySet<string>>(new Set())
  const before = useRef(seen)
  const changed = useEffectEvent(() => {
    setMarkers(m => markTabs(m, before.current, seen, tab))
    before.current = seen
  })
  // `seen` is rebuilt on every render: its text says when it changed.
  const seenText = JSON.stringify(seen)
  useEffect(() => {
    changed()
  }, [seenText, tab])
  return markers
}

/** Reads the current run, again whenever the runs change (a result may land after its code). */
export function useRunView(run: Run | undefined, runs: Run[], table: number): RunView | undefined {
  const [view, setView] = useState<RunView>()
  const number = run?.number
  const files = run && `${run.code ?? ''}:${run.data ?? ''}`
  useEffect(() => {
    if (number === undefined) return
    let live = true
    void window.app.readRun(number, { table }).then(v => {
      if (live) setView(v)
    })
    return () => {
      live = false
    }
    // files and runs: re-read when the run's files or any state push change, so a rewritten result shows.
  }, [number, files, table, runs])
  return number !== undefined && view?.run.number === number ? view : undefined
}

// Every tab's component, by id. A tab in the registry (core/tabs.ts) without an entry here fails the typecheck.
import type { ComponentType } from 'react'

import type { AnalysisState } from '../../shared/ipc.ts'
import type { PaneOf, TabId } from '../../core/tabs.ts'
import { Code } from './code.tsx'
import { Data } from './data.tsx'
import { Files } from './files.tsx'
import { History } from './history.tsx'
import { Notes, notesLabel } from './notes.tsx'
import { Overview } from './overview.tsx'
import { Plots } from './plots.tsx'
import { Steps } from './steps.tsx'
import { Threads, threadsLabel } from './threads.tsx'
import { Trust } from './trust.tsx'
import type { DataTabProps, NotesTabProps } from './types.ts'

type PropsOf<P> = P extends 'notes' ? NotesTabProps : DataTabProps

/** A tab's component, and its label when that is more than the registry's title. */
export type TabView<P> = { Component: ComponentType<PropsOf<P>>; label?: (state: AnalysisState) => string }

export const TAB_VIEWS: { [K in TabId]: TabView<PaneOf<K>> } = {
  overview: { Component: Overview },
  threads: { Component: Threads, label: threadsLabel },
  notes: { Component: Notes, label: notesLabel },
  files: { Component: Files },
  data: { Component: Data },
  plots: { Component: Plots },
  code: { Component: Code },
  history: { Component: History },
  steps: { Component: Steps },
  trust: { Component: Trust },
}

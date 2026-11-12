// The shared props of each pane's tab components (docs/developer/adding-a-tab.md).
import type { AnalysisState } from '../../shared/ipc.ts'
import type { Reveal } from '../components/common.tsx'

export type { DataTabProps } from '../components/DataPane.tsx'

/** What the notes pane hands the tab on screen. */
export type NotesTabProps = {
  state: AnalysisState
  /** A universal-search hit for this tab to select, if it is this tab's kind. */
  reveal: Reveal | undefined
  onRevealed: () => void
  /** A note's citation was followed: hold that run in the data pane. */
  onShowRun: (number: number) => void
}

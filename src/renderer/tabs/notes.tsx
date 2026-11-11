import { noteGroups, notesTabLabel } from '../../core/notesView.ts'
import { NotesTab } from '../components/NotesTab.tsx'
import type { NotesTabProps } from './types.ts'

export function Notes({ state, reveal, onRevealed, onShowRun }: Readonly<NotesTabProps>) {
  return (
    <NotesTab
      key="notes"
      slug={state.analysis.name}
      rootNotes={state.rootNotes}
      noteLists={state.noteLists}
      runs={state.runs}
      onShowRun={onShowRun}
      reveal={reveal}
      onRevealed={onRevealed}
    />
  )
}

/** The tab's label: how many notes this analysis has. */
export const notesLabel = (state: NotesTabProps['state']) => notesTabLabel(noteGroups(state.rootNotes, state.noteLists))

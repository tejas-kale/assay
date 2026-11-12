import { guardTab } from '../../../core/appCommands.ts'
import type { AnalysisState } from '../../../shared/ipc.ts'
import { Workspace } from '../Workspace.tsx'
import type { AppWindow } from './useAppWindow.ts'

/** The open analysis. A tab chosen while it is off gives its toast instead. */
export function WorkspaceScreen({ state, w, ctrlHeld }: Readonly<{ state: AnalysisState; w: AppWindow; ctrlHeld: boolean }>) {
  const { tabs, apply } = w
  return (
    <Workspace
      state={state}
      tabPrefs={tabs}
      notesTab={w.notesTab}
      dataTab={w.dataTab}
      onNotesTab={tab => {
        apply(guardTab(tabs, tab, [{ type: 'notes-tab', tab }, { type: 'focus', pane: 'notes' }]))
      }}
      onDataTab={tab => {
        apply(guardTab(tabs, tab, [{ type: 'data-tab', tab }, { type: 'focus', pane: 'data' }]))
      }}
      focusRequest={w.focusRequest}
      dataCommand={w.dataCommand}
      onToast={w.showToast}
      toast={w.toast}
      hints={ctrlHeld}
      zoomed={w.zoomed}
      onShowRun={number => {
        apply(guardTab(tabs, 'data', [{ type: 'show-run', number }]))
      }}
      reveal={w.reveal}
      onRevealed={() => {
        w.setReveal(undefined)
      }}
    />
  )
}

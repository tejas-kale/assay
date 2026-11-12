import { planCommand } from '../../../core/appCommands.ts'
import type { CommandContext, PaneName } from '../../../core/appCommands.ts'
import type { CommandId } from '../../../core/keymap.ts'
import { runningPythonRun } from '../../../core/runs.ts'
import type { SettingsView } from '../../../shared/ipc.ts'
import type { View } from './appView.ts'
import type { AppWindow } from './useAppWindow.ts'

/** The pane the keyboard focus is in. */
export const paneOfActive = (): PaneName | undefined =>
  document.activeElement?.closest<HTMLElement>('[data-pane]')?.dataset['pane'] as PaneName | undefined

function commandContext(view: View, settings: SettingsView | undefined, w: AppWindow): CommandContext {
  return {
    tabs: w.tabs,
    inWorkspace: view.type === 'workspace',
    pythonRunning: view.type === 'workspace' && runningPythonRun(view.state.runs, view.state.runStatus) !== undefined,
    activePane: paneOfActive(),
    palette: w.palette,
    search: w.search,
    settings: w.settingsOpen,
    needsFolder: settings !== undefined && !settings.root,
  }
}

/** Runs a command: plans it for the window as it is, and carries the plan out. Returns true when it moved the focus itself. */
export function runCommand(id: CommandId, view: View, settings: SettingsView | undefined, w: AppWindow): boolean {
  const { effects, movedFocus } = planCommand(id, commandContext(view, settings, w))
  w.apply(effects)
  return movedFocus
}

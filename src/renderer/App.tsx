import { defaultTabPrefs } from '../core/tabs.ts'
import { GlobalHints, ShortcutsOverlay } from './components/KeyHints.tsx'
import { Picker } from './components/Picker.tsx'
import { Overlays } from './components/app/Overlays.tsx'
import { WorkspaceScreen } from './components/app/WorkspaceScreen.tsx'
import { useCommandChannel, useReviewTab, useSettings, useView } from './components/app/appView.ts'
import { runCommand } from './components/app/runCommand.ts'
import { useAppWindow } from './components/app/useAppWindow.ts'

const DEFAULT_TABS = defaultTabPrefs()

export function App() {
  const { view, loadState } = useView()
  const { settings, hints } = useSettings()
  const w = useAppWindow(settings?.tabs ?? DEFAULT_TABS)
  const run = (id: Parameters<typeof runCommand>[0]) => runCommand(id, view, settings, w)
  useReviewTab(view, w)
  useCommandChannel(run)

  return (
    <>
      {view.type === 'picker' && settings?.root && <Picker key={settings.root} focusToken={w.pickerFocus} onOpened={loadState} />}
      {view.type === 'workspace' && <WorkspaceScreen state={view.state} w={w} ctrlHeld={hints === 'ctrl'} />}
      <Overlays view={view} settings={settings} w={w} run={run} />
      {hints === 'cmd' && <GlobalHints />}
      {w.shortcuts > 0 && (
        <ShortcutsOverlay
          key={w.shortcuts}
          onDone={() => {
            w.setShortcuts(0)
          }}
        />
      )}
      {view.type === 'picker' && w.toast && <div className="toast floating">{w.toast}</div>}
    </>
  )
}

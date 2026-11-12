import { closePaletteEffects, closeSearchEffects, closeSettingsEffects, hitEffects, restoreFocus } from '../../../core/appCommands.ts'
import type { CommandId } from '../../../core/keymap.ts'
import { hitTab, isTabOn } from '../../../core/tabs.ts'
import type { SettingsView } from '../../../shared/ipc.ts'
import { Palette } from '../Palette.tsx'
import { RenameDialog } from '../RenameDialog.tsx'
import { Search } from '../Search.tsx'
import { Settings } from '../Settings.tsx'
import type { View } from './appView.ts'
import type { AppWindow } from './useAppWindow.ts'

type Props = Readonly<{
  view: View
  settings: SettingsView | undefined
  w: AppWindow
  /** Runs a command; true when it moved the focus itself. */
  run: (id: CommandId) => boolean
}>

function PaletteOverlay({ w, run }: Readonly<{ w: AppWindow; run: Props['run'] }>) {
  const { palette, apply } = w
  if (!palette) return null
  return (
    <Palette
      onClose={() => {
        apply(closePaletteEffects(palette, true))
      }}
      onRun={id => {
        apply(closePaletteEffects(palette, false))
        // Running palette.open from the palette just closes it, so focus goes back like any other close.
        const movedFocus = id === 'palette.open' ? false : run(id)
        if (!movedFocus) apply([restoreFocus(palette.returnTo)])
      }}
    />
  )
}

function SearchOverlay({ view, w }: Readonly<{ view: View; w: AppWindow }>) {
  const { search, tabs, apply } = w
  if (!search || view.type !== 'workspace') return null
  return (
    <Search
      state={view.state}
      isShown={kind => isTabOn(tabs, hitTab(kind))}
      onChoose={target => {
        apply(hitEffects(target, tabs))
      }}
      onClose={() => {
        apply(closeSearchEffects(search))
      }}
    />
  )
}

/** The pop-ups over the window: the palette, the search, the rename dialog and Settings (which also fills the picker's place until a folder is set). */
export function Overlays({ view, settings, w, run }: Props) {
  const { settingsOpen, apply } = w
  return (
    <>
      <SearchOverlay view={view} w={w} />
      <PaletteOverlay w={w} run={run} />
      {w.renaming && view.type === 'workspace' && (
        <RenameDialog
          title={view.state.analysis.title}
          onDone={() => {
            w.setRenaming(false)
            apply([{ type: 'focus', pane: 'terminal' }])
          }}
        />
      )}
      {settingsOpen && settings && (
        <Settings
          settings={settings}
          onClose={() => {
            apply(closeSettingsEffects(settingsOpen))
          }}
        />
      )}
      {!settingsOpen && settings && !settings.root && view.type === 'picker' && <Settings settings={settings} onClose={undefined} />}
    </>
  )
}

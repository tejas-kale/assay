import { useCallback, useEffect, useRef, useState } from 'react'

import type { CommandId } from '../core/keymap.ts'
import { runningPythonRun } from '../core/runs.ts'
import type { AnalysisState, SettingsView } from '../shared/ipc.ts'
import { GlobalHints, ShortcutsOverlay } from './components/KeyHints.tsx'
import { Palette } from './components/Palette.tsx'
import { Picker } from './components/Picker.tsx'
import { Settings } from './components/Settings.tsx'
import { Workspace } from './components/Workspace.tsx'
import type { DataCommand } from './components/DataPane.tsx'
import type { FocusRequest } from './components/Workspace.tsx'
import type { DataTabName, NotesTabName, PaneName } from './components/common.tsx'

type View = { type: 'loading' } | { type: 'picker' } | { type: 'workspace'; state: AnalysisState }

const paneOfActive = (): PaneName | undefined =>
  (document.activeElement?.closest<HTMLElement>('[data-pane]')?.dataset['pane'] as PaneName | undefined) ?? undefined

export function App() {
  const [view, setView] = useState<View>({ type: 'loading' })
  const [notesTab, setNotesTab] = useState<NotesTabName>('threads')
  const [dataTab, setDataTab] = useState<DataTabName>('data')
  const [focusRequest, setFocusRequest] = useState<FocusRequest>()
  const [dataCommand, setDataCommand] = useState<DataCommand>()
  const [palette, setPalette] = useState<{ returnTo: PaneName | undefined }>()
  const [settingsOpen, setSettingsOpen] = useState<{ returnTo: PaneName | undefined }>()
  const [settings, setSettings] = useState<SettingsView>()
  const [hints, setHints] = useState(false)
  const [shortcuts, setShortcuts] = useState(0)
  const [pickerFocus, setPickerFocus] = useState(0)
  const [toast, setToast] = useState<string>()
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const counter = useRef(0)
  const paletteRef = useRef(palette)
  paletteRef.current = palette
  const settingsOpenRef = useRef(settingsOpen)
  settingsOpenRef.current = settingsOpen
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const viewRef = useRef(view)
  viewRef.current = view

  const loadState = useCallback(() => {
    window.app.state.get().then(
      state => setView(state ? { type: 'workspace', state } : { type: 'picker' }),
      () => setView({ type: 'picker' }),
    )
  }, [])

  useEffect(() => {
    loadState()
    return window.app.state.onChange(state => setView({ type: 'workspace', state }))
  }, [loadState])

  useEffect(() => {
    void window.app.settings.get().then(setSettings)
    const stops = [window.app.settings.onChange(setSettings), window.app.onHints(setHints)]
    return () => stops.forEach(stop => stop())
  }, [])

  const showToast = useCallback((text: string) => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(undefined), 4000)
  }, [])

  const focusPane = useCallback((pane: PaneName) => setFocusRequest({ pane, n: ++counter.current }), [])

  /** Runs a command. Returns true when it moved focus itself. */
  const run = useCallback(
    (id: CommandId): boolean => {
      switch (id) {
        case 'focus.terminal':
          focusPane('terminal')
          return true
        case 'focus.notes':
          // Pressed again inside the pane, it switches between Threads and Notes.
          if (paneOfActive() === 'notes') setNotesTab(tab => (tab === 'threads' ? 'notes' : tab === 'notes' ? 'files' : 'threads'))
          focusPane('notes')
          return true
        case 'shortcuts.show':
          setShortcuts(n => n + 1)
          return false
        case 'focus.data':
          focusPane('data')
          return true
        case 'tab.notes':
        case 'tab.threads':
        case 'tab.files':
          setNotesTab(id.slice(4) as NotesTabName)
          focusPane('notes')
          return true
        case 'tab.data':
        case 'tab.plots':
        case 'tab.code':
        case 'tab.history':
          setDataTab(id.slice(4) as DataTabName)
          focusPane('data')
          return true
        case 'settings.open': {
          const from = paletteRef.current
          setPalette(undefined)
          if (!settingsOpenRef.current) setSettingsOpen({ returnTo: from ? from.returnTo : paneOfActive() })
          return true
        }
        case 'palette.open': {
          // Settings is on top, and without a folder it must stay there.
          if (settingsOpenRef.current || (settingsRef.current && !settingsRef.current.root)) return true
          const open = paletteRef.current
          if (!open) {
            setPalette({ returnTo: paneOfActive() })
            return true
          }
          // Toggle off: give focus back to where the palette came from.
          setPalette(undefined)
          if (open.returnTo) focusPane(open.returnTo)
          else setPickerFocus(n => n + 1)
          return true
        }
        case 'code.run':
        case 'pin.toggle':
          setDataCommand({ id, n: ++counter.current })
          return false
        case 'run.interrupt': {
          const state = viewRef.current.type === 'workspace' ? viewRef.current.state : undefined
          if (!state || !runningPythonRun(state.runs, state.runStatus)) {
            showToast('Nothing is running.')
            return false
          }
          setDataCommand({ id, n: ++counter.current })
          focusPane('data')
          return true
        }
        case 'kernel.restart':
        case 'replay.open':
          // The pane shows its own prompt or view and takes the keys: focus must be there for y, n and the list keys.
          if (viewRef.current.type !== 'workspace') {
            showToast('Open an analysis first.')
            return false
          }
          setDataCommand({ id, n: ++counter.current })
          focusPane('data')
          return true
        case 'code.edit':
          // The pane switches to Code and focuses the editor itself once it has the run's text.
          setDataCommand({ id, n: ++counter.current })
          return true
        case 'window.new':
          void window.app.newWindow()
          return false
        case 'window.close':
          void window.app.closeWindow()
          return false
        default:
          return false
      }
    },
    [focusPane, showToast],
  )

  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => window.app.onCommand(id => runRef.current(id)), [])

  const closeSettings = () => {
    const returnTo = settingsOpen?.returnTo
    setSettingsOpen(undefined)
    if (returnTo) focusPane(returnTo)
    else setPickerFocus(n => n + 1)
  }

  const closePalette = (restore: boolean) => {
    const returnTo = palette?.returnTo
    setPalette(undefined)
    if (!restore) return
    if (returnTo) focusPane(returnTo)
    else setPickerFocus(n => n + 1)
  }

  return (
    <>
      {view.type === 'picker' && settings?.root && <Picker key={settings.root} focusToken={pickerFocus} onOpened={loadState} />}
      {view.type === 'workspace' && (
        <Workspace
          state={view.state}
          notesTab={notesTab}
          dataTab={dataTab}
          onNotesTab={tab => {
            setNotesTab(tab)
            focusPane('notes')
          }}
          onDataTab={tab => {
            setDataTab(tab)
            focusPane('data')
          }}
          focusRequest={focusRequest}
          dataCommand={dataCommand}
          onToast={showToast}
          toast={toast}
          hints={hints}
        />
      )}
      {palette && (
        <Palette
          onClose={() => closePalette(true)}
          onRun={id => {
            const returnTo = palette.returnTo
            setPalette(undefined)
            // Running palette.open from the palette just closes it, so focus goes back like any other close.
            const movedFocus = id === 'palette.open' ? false : run(id)
            if (!movedFocus) {
              if (returnTo) focusPane(returnTo)
              else setPickerFocus(n => n + 1)
            }
          }}
        />
      )}
      {settingsOpen && settings && <Settings root={settings.root} onClose={closeSettings} />}
      {!settingsOpen && settings && !settings.root && view.type === 'picker' && <Settings root={undefined} onClose={undefined} />}
      {hints && <GlobalHints />}
      {shortcuts > 0 && <ShortcutsOverlay key={shortcuts} onDone={() => setShortcuts(0)} />}
      {view.type === 'picker' && toast && <div className="toast floating">{toast}</div>}
    </>
  )
}

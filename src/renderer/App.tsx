import { useCallback, useEffect, useRef, useState } from 'react'

import { COMMANDS } from '../core/keymap.ts'
import type { CommandId } from '../core/keymap.ts'
import type { AnalysisState } from '../shared/ipc.ts'
import { Palette } from './components/Palette.tsx'
import { Picker } from './components/Picker.tsx'
import { Workspace } from './components/Workspace.tsx'
import type { FocusRequest } from './components/Workspace.tsx'
import type { DataTabName, NotesTabName, PaneName } from './components/common.tsx'

type View = { type: 'loading' } | { type: 'picker' } | { type: 'workspace'; state: AnalysisState }

const paneOfActive = (): PaneName | undefined =>
  (document.activeElement?.closest<HTMLElement>('[data-pane]')?.dataset['pane'] as PaneName | undefined) ?? undefined

export function App() {
  const [view, setView] = useState<View>({ type: 'loading' })
  const [notesTab, setNotesTab] = useState<NotesTabName>('notes')
  const [dataTab, setDataTab] = useState<DataTabName>('data')
  const [focusRequest, setFocusRequest] = useState<FocusRequest>()
  const [palette, setPalette] = useState<{ returnTo: PaneName | undefined }>()
  const [pickerFocus, setPickerFocus] = useState(0)
  const [toast, setToast] = useState<string>()
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const counter = useRef(0)
  const paletteRef = useRef(palette)
  paletteRef.current = palette

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

  const showToast = useCallback((text: string) => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(undefined), 4000)
  }, [])

  const focusPane = useCallback((pane: PaneName) => setFocusRequest({ pane, n: ++counter.current }), [])

  /** Runs a command. Returns true when it moved focus itself. */
  const run = useCallback(
    (id: CommandId): boolean => {
      const command = COMMANDS.find(c => c.id === id)
      if (command?.unavailable) {
        showToast(command.unavailable)
        return false
      }
      switch (id) {
        case 'focus.terminal':
          focusPane('terminal')
          return true
        case 'focus.notes':
          focusPane('notes')
          return true
        case 'focus.data':
          focusPane('data')
          return true
        case 'tab.notes':
        case 'tab.threads':
          setNotesTab(id === 'tab.notes' ? 'notes' : 'threads')
          focusPane('notes')
          return true
        case 'tab.data':
        case 'tab.plots':
        case 'tab.code':
        case 'tab.history':
          setDataTab(id.slice(4) as DataTabName)
          focusPane('data')
          return true
        case 'palette.open': {
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
          showToast('Run current code arrives in slice 2')
          return false
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

  const closePalette = (restore: boolean) => {
    const returnTo = palette?.returnTo
    setPalette(undefined)
    if (!restore) return
    if (returnTo) focusPane(returnTo)
    else setPickerFocus(n => n + 1)
  }

  return (
    <>
      {view.type === 'picker' && <Picker focusToken={pickerFocus} onOpened={loadState} />}
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
          toast={toast}
        />
      )}
      {palette && (
        <Palette
          onClose={() => closePalette(true)}
          onRun={id => {
            const returnTo = palette.returnTo
            setPalette(undefined)
            const movedFocus = id === 'palette.open' ? true : run(id)
            if (!movedFocus) {
              if (returnTo) focusPane(returnTo)
              else setPickerFocus(n => n + 1)
            }
          }}
        />
      )}
      {view.type === 'picker' && toast && <div className="toast floating">{toast}</div>}
    </>
  )
}

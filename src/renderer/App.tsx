import { useCallback, useEffect, useRef, useState } from 'react'

import { analysisNumber, tabAction } from '../core/keymap.ts'
import { defaultTabPrefs, hitTab, isTabOn, nextTab, shownTab, tabOffText } from '../core/tabs.ts'
import type { TabId, TabIdIn, TabPrefs } from '../core/tabs.ts'
import type { CommandId } from '../core/keymap.ts'
import type { HoldKind } from '../core/cmdHold.ts'
import { runningPythonRun } from '../core/runs.ts'
import type { AnalysisState, SettingsView } from '../shared/ipc.ts'
import { GlobalHints, ShortcutsOverlay } from './components/KeyHints.tsx'
import { Palette } from './components/Palette.tsx'
import { RenameDialog } from './components/RenameDialog.tsx'
import { Picker } from './components/Picker.tsx'
import { Search } from './components/Search.tsx'
import { Settings } from './components/Settings.tsx'
import { Workspace } from './components/Workspace.tsx'
import type { DataCommand } from './components/DataPane.tsx'
import type { FocusRequest } from './components/Workspace.tsx'
import type { PaneName, Reveal } from './components/common.tsx'
import type { SearchTarget } from '../core/search.ts'

const DEFAULT_TABS = defaultTabPrefs()

type View = { type: 'loading' } | { type: 'picker' } | { type: 'workspace'; state: AnalysisState }

const paneOfActive = (): PaneName | undefined =>
  (document.activeElement?.closest<HTMLElement>('[data-pane]')?.dataset['pane'] as PaneName | undefined) ?? undefined

export function App() {
  const [view, setView] = useState<View>({ type: 'loading' })
  const [notesTab, setNotesTab] = useState<TabIdIn<'notes'>>('threads')
  const [dataTab, setDataTab] = useState<TabIdIn<'data'>>('data')
  const [focusRequest, setFocusRequest] = useState<FocusRequest>()
  // Ctrl+0: the terminal fills the analysis. Focus moving to another pane brings the panes back, so it never lands in a hidden one.
  const [zoomed, setZoomed] = useState(false)
  const [dataCommand, setDataCommand] = useState<DataCommand>()
  const [palette, setPalette] = useState<{ returnTo: PaneName | undefined }>()
  const [searchOpen, setSearchOpen] = useState<{ returnTo: PaneName | undefined }>()
  const [reveal, setReveal] = useState<Reveal>()
  const [settingsOpen, setSettingsOpen] = useState<{ returnTo: PaneName | undefined }>()
  const [settings, setSettings] = useState<SettingsView>()
  const [isRenaming, setRenaming] = useState(false)
  const [hints, setHints] = useState<HoldKind>()
  const [shortcuts, setShortcuts] = useState(0)
  const [pickerFocus, setPickerFocus] = useState(0)
  const [toast, setToast] = useState<string>()
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const counter = useRef(0)
  const paletteRef = useRef(palette)
  paletteRef.current = palette
  const searchRef = useRef(searchOpen)
  searchRef.current = searchOpen
  const settingsOpenRef = useRef(settingsOpen)
  settingsOpenRef.current = settingsOpen
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const viewRef = useRef(view)
  viewRef.current = view
  const tabPrefs = settings?.tabs ?? DEFAULT_TABS
  /** The tab settings, for handlers that outlive a render. */
  const currentTabs = useCallback((): TabPrefs => settingsRef.current?.tabs ?? DEFAULT_TABS, [])
  const showToast = useCallback((text: string) => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(undefined), 4000)
  }, [])

  /** A new trust review shows the Trust tab, or says it is off. */
  const showReview = useCallback(() => {
    if (isTabOn(currentTabs(), 'trust')) setDataTab('trust')
    else showToast(tabOffText('trust'))
  }, [currentTabs, showToast])
  // The newest review start the data pane has switched to; undefined until the first state, whose review is only the baseline.
  const trustStart = useRef<number | null | undefined>(undefined)
  const reviewStart = view.type === 'workspace' ? (view.state.trust?.startedAt ?? null) : undefined
  useEffect(() => {
    if (reviewStart === undefined) return
    const known = trustStart.current
    trustStart.current = reviewStart
    // A new review shows the Trust tab, but the keyboard stays where the user is typing (Claude).
    if (known !== undefined && reviewStart !== null && reviewStart !== known) showReview()
  }, [reviewStart, showReview])

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


  const focusPane = useCallback((pane: PaneName) => {
    if (pane !== 'terminal') setZoomed(false)
    setFocusRequest({ pane, n: ++counter.current })
  }, [])

  /** Runs a command. Returns true when it moved focus itself. */
  const run = useCallback(
    (id: CommandId): boolean => {
      const action = tabAction(id, currentTabs())
      if (action?.type === 'toast') {
        showToast(action.text)
        return false
      }
      if (action?.type === 'show') {
        if (action.pane === 'notes') setNotesTab(action.tab as TabIdIn<'notes'>)
        else setDataTab(action.tab as TabIdIn<'data'>)
        focusPane(action.pane)
        return true
      }
      switch (id) {
        case 'focus.terminal':
          focusPane('terminal')
          return true
        case 'terminal.zoom':
          if (viewRef.current.type !== 'workspace') return false
          setZoomed(z => !z)
          focusPane('terminal')
          return true
        case 'focus.notes':
          // Pressed again inside the pane, it cycles through the tabs that are on, in the user's order.
          if (paneOfActive() === 'notes') {
            const prefs = currentTabs()
            setNotesTab(tab => (nextTab(prefs, 'notes', shownTab(prefs, 'notes', tab) ?? tab) as TabIdIn<'notes'> | undefined) ?? tab)
          }
          focusPane('notes')
          return true
        case 'shortcuts.show':
          setShortcuts(n => n + 1)
          return false
        case 'focus.data':
          focusPane('data')
          return true
        case 'settings.open': {
          const from = paletteRef.current ?? searchRef.current
          setPalette(undefined)
          setSearchOpen(undefined)
          if (!settingsOpenRef.current) setSettingsOpen({ returnTo: from ? from.returnTo : paneOfActive() })
          return true
        }
        case 'palette.open': {
          // Settings is on top, and without a folder it must stay there.
          if (settingsOpenRef.current || (settingsRef.current && !settingsRef.current.root)) return true
          const open = paletteRef.current
          if (!open) {
            // Over the search, the palette takes its place and its way back.
            const search = searchRef.current
            setSearchOpen(undefined)
            setPalette({ returnTo: search ? search.returnTo : paneOfActive() })
            return true
          }
          // Toggle off: give focus back to where the palette came from.
          setPalette(undefined)
          if (open.returnTo) focusPane(open.returnTo)
          else setPickerFocus(n => n + 1)
          return true
        }
        case 'search.open': {
          if (settingsOpenRef.current) return true
          if (viewRef.current.type !== 'workspace') {
            showToast('Open an analysis first.')
            return false
          }
          const open = searchRef.current
          if (open) {
            setSearchOpen(undefined)
            if (open.returnTo) focusPane(open.returnTo)
            return true
          }
          // From the palette, the way back is the palette's.
          const from = paletteRef.current
          setPalette(undefined)
          setSearchOpen({ returnTo: from ? from.returnTo : paneOfActive() })
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
        case 'analysis.rename':
          if (viewRef.current.type !== 'workspace') {
            showToast('Open an analysis first.')
            return false
          }
          setRenaming(true)
          return true
        case 'code.edit':
        case 'code.new':
          // The pane switches to Code and focuses the editor itself once it has the run's text.
          setZoomed(false)
          setDataCommand({ id, n: ++counter.current })
          return true
        case 'analysis.new':
          void window.app.newWindow()
          return false
        case 'analysis.close':
          void window.app.closeWindow()
          return false
        case 'strip.side':
          void window.app.toggleStripSide()
          return false
        case 'update.restart':
          void window.app.update.restart()
          return false
        default: {
          // Show analysis N, from the palette; the keys go straight to main.
          const n = analysisNumber(id)
          if (n !== undefined) void window.app.showAnalysis(n)
          return false
        }
      }
    },
    [focusPane, showToast, currentTabs],
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

  const closeSearch = () => {
    const returnTo = searchOpen?.returnTo
    setSearchOpen(undefined)
    if (returnTo) focusPane(returnTo)
  }

  /** Shows a search hit in its own tab: a run in the data pane, the rest in the notes pane. */
  const showHit = (target: SearchTarget) => {
    setSearchOpen(undefined)
    if (!guardTab(hitTab(target.kind))) return
    if (target.kind === 'run') {
      setDataCommand({ id: 'run.show', number: target.number, n: ++counter.current })
      focusPane('data')
      return
    }
    setNotesTab(target.kind === 'thread' ? 'threads' : target.kind === 'file' ? 'files' : 'notes')
    setReveal({ target, n: ++counter.current })
    focusPane('notes')
  }

  /** True while `tab` is on; otherwise shows its toast. */
  const guardTab = (tab: TabId): boolean => {
    if (isTabOn(tabPrefs, tab)) return true
    showToast(tabOffText(tab))
    return false
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
          tabPrefs={tabPrefs}
          notesTab={notesTab}
          dataTab={dataTab}
          onNotesTab={tab => {
            if (!guardTab(tab)) return
            setNotesTab(tab)
            focusPane('notes')
          }}
          onDataTab={tab => {
            if (!guardTab(tab)) return
            setDataTab(tab)
            focusPane('data')
          }}
          focusRequest={focusRequest}
          dataCommand={dataCommand}
          onToast={showToast}
          toast={toast}
          hints={hints === 'ctrl'}
          zoomed={zoomed}
          onShowRun={number => guardTab('data') && setDataCommand({ id: 'run.show', number, n: ++counter.current })}
          reveal={reveal}
          onRevealed={() => setReveal(undefined)}
        />
      )}
      {searchOpen && view.type === 'workspace' && <Search state={view.state} isShown={kind => isTabOn(tabPrefs, hitTab(kind))} onChoose={showHit} onClose={closeSearch} />}
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
      {isRenaming && view.type === 'workspace' && (
        <RenameDialog
          title={view.state.analysis.title}
          onDone={() => {
            setRenaming(false)
            focusPane('terminal')
          }}
        />
      )}
      {settingsOpen && settings && <Settings settings={settings} onClose={closeSettings} />}
      {!settingsOpen && settings && !settings.root && view.type === 'picker' && <Settings settings={settings} onClose={undefined} />}
      {hints === 'cmd' && <GlobalHints />}
      {shortcuts > 0 && <ShortcutsOverlay key={shortcuts} onDone={() => setShortcuts(0)} />}
      {view.type === 'picker' && toast && <div className="toast floating">{toast}</div>}
    </>
  )
}

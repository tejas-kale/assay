import { useEffect, useRef, useState } from 'react'

import type { AnalysisState, CloseState, PtyExit } from '../../shared/ipc.ts'
import type { TerminalHandle } from '../terminal.ts'
import { shortcutLabel } from '../../core/keymap.ts'
import { hitTab, isPaneHidden, shownTab, tabSpec, visibleTabs } from '../../core/tabs.ts'
import type { Pane, TabId, TabIdIn, TabPrefs } from '../../core/tabs.ts'
import { TAB_VIEWS } from '../tabs/index.ts'
import { Banners } from './Banners.tsx'
import { PaneHint } from './KeyHints.tsx'
import { DataPane } from './DataPane.tsx'
import type { DataCommand } from './DataPane.tsx'
import { TerminalPane } from './TerminalPane.tsx'
import { UpdateBanner } from './Updates.tsx'
import type { PaneName, Reveal } from './common.tsx'

export type FocusRequest = { pane: PaneName; n: number }

type Props = {
  state: AnalysisState
  /** Settings > Tabs: which tabs are on, in which order. */
  tabPrefs: TabPrefs
  notesTab: TabIdIn<'notes'>
  dataTab: TabIdIn<'data'>
  onNotesTab: (tab: TabIdIn<'notes'>) => void
  onDataTab: (tab: TabIdIn<'data'>) => void
  focusRequest: FocusRequest | undefined
  /** The last pin, edit or run command, for the data pane to carry out. */
  dataCommand: DataCommand | undefined
  onToast: (text: string) => void
  /** A short message from the last command. */
  toast: string | undefined
  /** Left Ctrl is long-pressed: show each pane's shortcuts. */
  hints: boolean
  /** Ctrl+0: the terminal fills the analysis; notes and data stay mounted but hidden. */
  zoomed: boolean
  /** A note's citation was followed: hold that run in the data pane. */
  onShowRun: (number: number) => void
  /** A universal-search hit for the notes pane's tabs to select. */
  reveal: Reveal | undefined
  onRevealed: () => void
}

/** A pane's hint line: its focus key, then each visible tab's key. */
const paneHint = (pane: Pane, tabs: readonly TabId[]) =>
  [shortcutLabel(pane === 'notes' ? 'focus.notes' : 'focus.data'), ...tabs.map(id => `${tabSpec(id).title} ${shortcutLabel(`tab.${id}`)}`)].join('  ·  ')

export function Workspace({ state, tabPrefs, notesTab, dataTab, onNotesTab, onDataTab, focusRequest, dataCommand, onToast, toast, hints, zoomed, onShowRun, reveal, onRevealed }: Props) {
  const notesTabs = visibleTabs(tabPrefs, 'notes') as TabIdIn<'notes'>[]
  const dataTabs = visibleTabs(tabPrefs, 'data') as TabIdIn<'data'>[]
  // A chosen tab that is now off gives way to the pane's first tab that is on.
  const notesShown = shownTab(tabPrefs, 'notes', notesTab) as TabIdIn<'notes'> | undefined
  const dataShown = shownTab(tabPrefs, 'data', dataTab) as TabIdIn<'data'> | undefined
  const revealFor = (tab: TabIdIn<'notes'>) => (reveal && hitTab(reveal.target.kind) === tab ? reveal : undefined)
  const NotesBody = notesShown && TAB_VIEWS[notesShown].Component
  const hidden = [isPaneHidden(tabPrefs, 'notes') && 'no-notes', isPaneHidden(tabPrefs, 'data') && 'no-data'].filter(Boolean)
  const terminalRef = useRef<TerminalHandle | undefined>(undefined)
  const notesRef = useRef<HTMLElement>(null)
  const dataRef = useRef<HTMLElement>(null)
  const [closeState, setCloseState] = useState<CloseState>('running')
  const [exit, setExit] = useState<PtyExit>()

  useEffect(() => {
    const stops = [window.app.onCloseState(setCloseState), window.app.pty.onExit(setExit)]
    return () => stops.forEach(stop => stop())
  }, [])

  // Runs after the commit, so a just-switched tab already has its focus target.
  useEffect(() => {
    if (!focusRequest) return
    // A pane hidden by Settings > Tabs cannot take the keys: they go to Claude instead.
    const hiddenPane = focusRequest.pane !== 'terminal' && isPaneHidden(tabPrefs, focusRequest.pane)
    if (focusRequest.pane === 'terminal' || hiddenPane) {
      terminalRef.current?.focus()
      return
    }
    const section = focusRequest.pane === 'notes' ? notesRef.current : dataRef.current
    const target = section?.querySelector<HTMLElement>('[data-focus-target]') ?? section
    target?.focus()
  }, [focusRequest, tabPrefs])

  return (
    <div className={['workspace', zoomed && 'zoomed', ...hidden].filter(Boolean).join(' ')}>
      <section className="pane terminal-pane" data-pane="terminal" aria-label="Claude Code">
        <TerminalPane handleRef={terminalRef} />
        {hints && <PaneHint>{`${shortcutLabel('focus.terminal')}  ·  ${zoomed ? 'Restore' : 'Zoom'} ${shortcutLabel('terminal.zoom')}`}</PaneHint>}
      </section>

      <section className="pane" data-pane="notes" ref={notesRef} tabIndex={-1} aria-label="Notes and threads">
        <div className="tabs" role="tablist">
          {notesTabs.map(id => (
            <button key={id} role="tab" tabIndex={-1} aria-selected={notesShown === id} onClick={() => onNotesTab(id)}>
              {TAB_VIEWS[id].label?.(state) ?? tabSpec(id).title}
            </button>
          ))}
          <span className="grow" />
          <span className="dim title">{state.analysis.title}</span>
        </div>
        {hints && <PaneHint>{paneHint('notes', notesTabs)}</PaneHint>}
        {notesShown && NotesBody && <NotesBody key={notesShown} state={state} reveal={revealFor(notesShown)} onRevealed={onRevealed} onShowRun={onShowRun} />}
      </section>

      <section className="pane" data-pane="data" ref={dataRef} tabIndex={-1} aria-label="Data pane">
        {dataShown && (
          <DataPane
            tab={dataShown}
            tabs={dataTabs}
            Body={TAB_VIEWS[dataShown].Component}
            runs={state.runs}
            status={state.runStatus}
            trust={state.trust}
            onTab={onDataTab}
            command={dataCommand}
            onToast={onToast}
          />
        )}
        {hints && <PaneHint>{paneHint('data', dataTabs)}</PaneHint>}
      </section>

      <div className="float-status">
        {toast && <span className="toast">{toast}</span>}
        <Banners closeState={closeState} exit={exit} />
        <UpdateBanner />
      </div>
    </div>
  )
}

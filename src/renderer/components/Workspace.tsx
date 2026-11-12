import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

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

type Props = Readonly<{
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
}>

const tabHint = (id: TabId) => [tabSpec(id).title, shortcutLabel(`tab.${id}`)].join(' ')

/** A pane's hint line: its focus key, then each visible tab's key. */
const paneHint = (pane: Pane, tabs: readonly TabId[]) =>
  [shortcutLabel(pane === 'notes' ? 'focus.notes' : 'focus.data'), ...tabs.map(tabHint)].join('  ·  ')

/** Whether the session is closing, and how it ended. */
function useSessionStatus() {
  const [closeState, setCloseState] = useState<CloseState>('running')
  const [exit, setExit] = useState<PtyExit>()
  useEffect(() => {
    const stops = [window.app.onCloseState(setCloseState), window.app.pty.onExit(setExit)]
    return () => {
      for (const stop of stops) stop()
    }
  }, [])
  return { closeState, exit }
}

type Panes = {
  terminal: RefObject<TerminalHandle | undefined>
  notes: RefObject<HTMLElement | null>
  data: RefObject<HTMLElement | null>
}

/** Moves the focus to the pane a command asked for. Runs after the commit, so a just-switched tab already has its focus target. */
function useFocusRequest(focusRequest: FocusRequest | undefined, tabPrefs: TabPrefs, { terminal, notes, data }: Panes) {
  useEffect(() => {
    if (!focusRequest) return
    // A pane hidden by Settings > Tabs cannot take the keys: they go to Claude instead.
    const hiddenPane = focusRequest.pane !== 'terminal' && isPaneHidden(tabPrefs, focusRequest.pane)
    if (focusRequest.pane === 'terminal' || hiddenPane) {
      terminal.current?.focus()
      return
    }
    const section = focusRequest.pane === 'notes' ? notes.current : data.current
    const target = section?.querySelector<HTMLElement>('[data-focus-target]') ?? section
    target?.focus()
  }, [focusRequest, tabPrefs, terminal, notes, data])
}

function NotesPane({ props, tabs, shown, paneRef }: Readonly<{ props: Props; tabs: TabIdIn<'notes'>[]; shown: TabIdIn<'notes'> | undefined; paneRef: RefObject<HTMLElement | null> }>) {
  const { state, reveal, hints, onNotesTab, onRevealed, onShowRun } = props
  const Body = shown && TAB_VIEWS[shown].Component
  const revealFor = (tab: TabIdIn<'notes'>) => (reveal && hitTab(reveal.target.kind) === tab ? reveal : undefined)
  return (
    <section className="pane" data-pane="notes" ref={paneRef} tabIndex={-1} aria-label="Notes and threads">
      <div className="tabs" role="tablist">
        {tabs.map(id => (
          <button key={id} role="tab" tabIndex={-1} aria-selected={shown === id} onClick={() => { onNotesTab(id) }}>
            {TAB_VIEWS[id].label?.(state) ?? tabSpec(id).title}
          </button>
        ))}
        <span className="grow" />
        <span className="dim title">{state.analysis.title}</span>
      </div>
      {hints && <PaneHint>{paneHint('notes', tabs)}</PaneHint>}
      {shown && Body && <Body key={shown} state={state} reveal={revealFor(shown)} onRevealed={onRevealed} onShowRun={onShowRun} />}
    </section>
  )
}

function DataSection({ props, tabs, shown, paneRef }: Readonly<{ props: Props; tabs: TabIdIn<'data'>[]; shown: TabIdIn<'data'> | undefined; paneRef: RefObject<HTMLElement | null> }>) {
  const { state, hints, dataCommand, onDataTab, onToast } = props
  return (
    <section className="pane" data-pane="data" ref={paneRef} tabIndex={-1} aria-label="Data pane">
      {shown && (
        <DataPane
          tab={shown}
          tabs={tabs}
          Body={TAB_VIEWS[shown].Component}
          runs={state.runs}
          status={state.runStatus}
          trust={state.trust}
          onTab={onDataTab}
          command={dataCommand}
          onToast={onToast}
        />
      )}
      {hints && <PaneHint>{paneHint('data', tabs)}</PaneHint>}
    </section>
  )
}

const terminalHint = (zoomed: boolean) =>
  [shortcutLabel('focus.terminal'), `${zoomed ? 'Restore' : 'Zoom'} ${shortcutLabel('terminal.zoom')}`].join('  ·  ')

export function Workspace(props: Props) {
  const { tabPrefs, notesTab, dataTab, focusRequest, toast, hints, zoomed } = props
  const notesTabs = visibleTabs(tabPrefs, 'notes') as TabIdIn<'notes'>[]
  const dataTabs = visibleTabs(tabPrefs, 'data') as TabIdIn<'data'>[]
  // A chosen tab that is now off gives way to the pane's first tab that is on.
  const notesShown = shownTab(tabPrefs, 'notes', notesTab) as TabIdIn<'notes'> | undefined
  const dataShown = shownTab(tabPrefs, 'data', dataTab) as TabIdIn<'data'> | undefined
  const hidden = [isPaneHidden(tabPrefs, 'notes') && 'no-notes', isPaneHidden(tabPrefs, 'data') && 'no-data'].filter(Boolean)
  const terminal = useRef<TerminalHandle | undefined>(undefined)
  const notes = useRef<HTMLElement>(null)
  const data = useRef<HTMLElement>(null)
  const { closeState, exit } = useSessionStatus()
  useFocusRequest(focusRequest, tabPrefs, { terminal, notes, data })

  return (
    <div className={['workspace', zoomed && 'zoomed', ...hidden].filter(Boolean).join(' ')}>
      <section className="pane terminal-pane" data-pane="terminal" aria-label="Claude Code">
        <TerminalPane handleRef={terminal} />
        {hints && <PaneHint>{terminalHint(zoomed)}</PaneHint>}
      </section>
      <NotesPane props={props} tabs={notesTabs} shown={notesShown} paneRef={notes} />
      <DataSection props={props} tabs={dataTabs} shown={dataShown} paneRef={data} />
      <div className="float-status">
        {toast && <span className="toast">{toast}</span>}
        <Banners closeState={closeState} exit={exit} />
        <UpdateBanner />
      </div>
    </div>
  )
}

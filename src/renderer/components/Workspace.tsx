import { useEffect, useRef, useState } from 'react'

import type { AnalysisState, CloseState, PtyExit } from '../../shared/ipc.ts'
import type { TerminalHandle } from '../terminal.ts'
import { Banners } from './Banners.tsx'
import { DATA_TABS, DataPane } from './DataPane.tsx'
import { NotesTab } from './NotesTab.tsx'
import { TerminalPane } from './TerminalPane.tsx'
import { ThreadsTab } from './ThreadsTab.tsx'
import type { DataTabName, NotesTabName, PaneName } from './common.tsx'

export type FocusRequest = { pane: PaneName; n: number }

type Props = {
  state: AnalysisState
  notesTab: NotesTabName
  dataTab: DataTabName
  onNotesTab: (tab: NotesTabName) => void
  onDataTab: (tab: DataTabName) => void
  focusRequest: FocusRequest | undefined
  /** A short message from the last command, shown in the footer. */
  toast: string | undefined
}

export function Workspace({ state, notesTab, dataTab, onNotesTab, onDataTab, focusRequest, toast }: Props) {
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
    if (focusRequest.pane === 'terminal') {
      terminalRef.current?.focus()
      return
    }
    const section = focusRequest.pane === 'notes' ? notesRef.current : dataRef.current
    const target = section?.querySelector<HTMLElement>('[data-focus-target]') ?? section
    target?.focus()
  }, [focusRequest])

  return (
    <div className="workspace">
      <section className="pane terminal-pane" data-pane="terminal" aria-label="Claude Code">
        <TerminalPane handleRef={terminalRef} />
      </section>

      <section className="pane" data-pane="notes" ref={notesRef} tabIndex={-1} aria-label="Notes and threads">
        <div className="tabs" role="tablist">
          {(['notes', 'threads'] as const).map(id => (
            <button key={id} role="tab" tabIndex={-1} aria-selected={notesTab === id} onClick={() => onNotesTab(id)}>
              {id === 'notes' ? 'Notes' : 'Threads'}
            </button>
          ))}
          <span className="grow" />
          <span className="dim title">{state.analysis.name}</span>
        </div>
        {notesTab === 'notes' ? <NotesTab key="notes" facts={state.facts} /> : <ThreadsTab key="threads" threads={state.threads} />}
      </section>

      <section className="pane" data-pane="data" ref={dataRef} tabIndex={-1} aria-label="Data pane">
        <div className="tabs" role="tablist">
          {DATA_TABS.map(t => (
            <button key={t.id} role="tab" tabIndex={-1} aria-selected={dataTab === t.id} onClick={() => onDataTab(t.id)}>
              {t.title}
            </button>
          ))}
        </div>
        <DataPane tab={dataTab} />
      </section>

      <footer className="footer">
        <Banners closeState={closeState} exit={exit} />
        {toast && <span className="toast">{toast}</span>}
        <span className="grow" />
        <span className="dim">Cmd+1 terminal  Cmd+2 notes  Cmd+3 data  Cmd+K palette</span>
      </footer>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

import type { AnalysisState, CloseState, PtyExit } from '../../shared/ipc.ts'
import type { TerminalHandle } from '../terminal.ts'
import { shortcutLabel } from '../../core/keymap.ts'
import { Banners } from './Banners.tsx'
import { PaneHint } from './KeyHints.tsx'
import { DATA_TABS, DataPane } from './DataPane.tsx'
import type { DataCommand } from './DataPane.tsx'
import { FilesTab } from './FilesTab.tsx'
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
  /** The last pin, edit or run command, for the data pane to carry out. */
  dataCommand: DataCommand | undefined
  onToast: (text: string) => void
  /** A short message from the last command. */
  toast: string | undefined
  /** Left Cmd is long-pressed: show each pane's shortcuts. */
  hints: boolean
}

export function Workspace({ state, notesTab, dataTab, onNotesTab, onDataTab, focusRequest, dataCommand, onToast, toast, hints }: Props) {
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
        {hints && <PaneHint>{shortcutLabel('focus.terminal')}</PaneHint>}
      </section>

      <section className="pane" data-pane="notes" ref={notesRef} tabIndex={-1} aria-label="Notes and threads">
        <div className="tabs" role="tablist">
          {(['threads', 'notes', 'files'] as const).map(id => (
            <button key={id} role="tab" tabIndex={-1} aria-selected={notesTab === id} onClick={() => onNotesTab(id)}>
              {id === 'notes' ? 'Notes' : id === 'threads' ? 'Threads' : 'Files'}
            </button>
          ))}
          <span className="grow" />
          <span className="dim title">{state.analysis.name}</span>
        </div>
        {hints && (
          <PaneHint>
            {`${shortcutLabel('focus.notes')}  ·  Threads ${shortcutLabel('tab.threads')}  ·  Notes ${shortcutLabel('tab.notes')}  ·  Files ${shortcutLabel('tab.files')}`}
          </PaneHint>
        )}
        {notesTab === 'notes' ? (
          <NotesTab key="notes" facts={state.facts} />
        ) : notesTab === 'threads' ? (
          <ThreadsTab key="threads" threads={state.threads} />
        ) : (
          <FilesTab key="files" refreshKey={state} />
        )}
      </section>

      <section className="pane" data-pane="data" ref={dataRef} tabIndex={-1} aria-label="Data pane">
        <DataPane tab={dataTab} runs={state.runs} status={state.runStatus} trust={state.trust} onTab={onDataTab} command={dataCommand} onToast={onToast} />
        {hints && (
          <PaneHint>
            {[shortcutLabel('focus.data'), ...DATA_TABS.map(t => `${t.title} ${shortcutLabel(`tab.${t.id}`)}`)].join('  ·  ')}
          </PaneHint>
        )}
      </section>

      <div className="float-status">
        {toast && <span className="toast">{toast}</span>}
        <Banners closeState={closeState} exit={exit} />
      </div>
    </div>
  )
}

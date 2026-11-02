import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { shortcutLabel } from '../../core/keymap.ts'
import type { Run, RunStatus, RunView } from '../../shared/ipc.ts'
import { CodeView } from './CodeView.tsx'
import { isPaneKey } from './common.tsx'
import type { DataTabName } from './common.tsx'

export const DATA_TABS: { id: DataTabName; title: string }[] = [
  { id: 'data', title: 'Data' },
  { id: 'plots', title: 'Plots' },
  { id: 'code', title: 'Code' },
  { id: 'history', title: 'History' },
]

type Props = {
  tab: DataTabName
  runs: Run[]
  status: RunStatus
  onTab: (tab: DataTabName) => void
}

/**
 * Data, Code and History over `queries/`. All show one current run: Claude's latest, unless a run
 * was chosen in History. Data links to the run's code and Code links back to its data.
 */
export function DataPane({ tab, runs, status, onTab }: Props) {
  const [chosen, setChosen] = useState<number>()
  const latest = runs.at(-1)
  const current = runs.find(r => r.number === chosen) ?? latest
  const following = chosen === undefined || chosen === latest?.number
  const view = useRunView(current, runs)

  const choose = (run: Run) => {
    setChosen(run.number === latest?.number ? undefined : run.number)
    onTab('data')
  }

  if (tab === 'plots') return <Placeholder text="Plots arrive in slice 3." />
  if (tab === 'history') return <History runs={runs} current={current} onChoose={choose} />
  if (!current) return <Placeholder text="No runs yet. Claude's queries appear here." />

  const header = (
    <RunHeader run={current} following={following} onFollow={() => setChosen(undefined)}>
      {tab === 'data' ? (
        <LinkButton onClick={() => onTab('code')} label="Code" shortcut={shortcutLabel('tab.code')} />
      ) : (
        <LinkButton onClick={() => onTab('data')} label="Data" shortcut={shortcutLabel('tab.data')} />
      )}
    </RunHeader>
  )
  return tab === 'data' ? (
    <DataTab header={header} view={view} status={status} run={current} onCode={() => onTab('code')} />
  ) : (
    <CodeTab header={header} view={view} status={status} run={current} onData={() => onTab('data')} />
  )
}

/** Reads the current run, again whenever the runs change (a result may land after its code). */
function useRunView(run: Run | undefined, runs: Run[]): RunView | undefined {
  const [view, setView] = useState<RunView>()
  const key = run ? `${run.number}:${run.code ?? ''}:${run.data ?? ''}` : ''
  useEffect(() => {
    if (!run) {
      setView(undefined)
      return
    }
    let live = true
    void window.app.readRun(run.number).then(v => {
      if (live) setView(v)
    })
    return () => {
      live = false
    }
    // runs: re-read on every state push, so a rewritten result shows.
  }, [key, runs])
  return view?.run.number === run?.number ? view : undefined
}

const Placeholder = ({ text }: { text: string }) => (
  <div className="list placeholder" tabIndex={-1} data-focus-target>
    <div className="empty">{text}</div>
  </div>
)

function LinkButton({ onClick, label, shortcut }: { onClick: () => void; label: string; shortcut: string }) {
  return (
    <button type="button" className="run-link" tabIndex={-1} onClick={onClick}>
      {label} → <span className="dim">{shortcut}</span>
    </button>
  )
}

function RunHeader(props: { run: Run; following: boolean; onFollow: () => void; children: ReactNode }) {
  return (
    <div className="run-header">
      <b>{props.run.label}</b>
      <span className="grow run-slug">{props.run.slug}</span>
      {!props.following && (
        <button type="button" className="run-link" tabIndex={-1} onClick={props.onFollow} title="Follow Claude's latest run">
          chosen in History · follow latest
        </button>
      )}
      {props.children}
    </div>
  )
}

/** What the Data and Code tabs say about a run with no result: running, failed, or simply none saved. */
function NoResult({ run, status }: { run: Run; status: RunStatus }) {
  const now = useNow(status.running?.number === run.number)
  if (status.running?.number === run.number) {
    const seconds = Math.max(0, Math.round((now - status.running.startedAt) / 1000))
    return <div className="empty running">Query {run.label} is running… {seconds} s</div>
  }
  const failed = status.failed[run.number]
  if (failed !== undefined) return <pre className="status warn run-error">Query {run.label} failed:{'\n'}{failed}</pre>
  return <div className="empty">No result saved for query {run.label}. It may have failed in an earlier session.</div>
}

/** Ticks once a second while `on`. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

type Cell = { row: number; col: number }

/**
 * The result table with a cell cursor: h/j/k/l move, J/K a page, g/G first/last row, 0/$ first/last
 * column. The selected cell's full value shows below the table; Enter shows the whole row; y copies.
 */
function DataTab(props: { header: ReactNode; view: RunView | undefined; status: RunStatus; run: Run; onCode: () => void }) {
  const { header, view, status, run, onCode } = props
  const table = view?.table
  const [cell, setCell] = useState<Cell>({ row: 0, col: 0 })
  const [rowOpen, setRowOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const rows = table?.rows.length ?? 0
  const cols = table?.columns.length ?? 0
  const at = { row: Math.max(0, Math.min(cell.row, rows - 1)), col: Math.max(0, Math.min(cell.col, cols - 1)) }

  // A new run starts at its first cell.
  useEffect(() => {
    setCell({ row: 0, col: 0 })
    setRowOpen(false)
  }, [run.number])

  useEffect(() => {
    ref.current?.querySelector('td.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [at.row, at.col, rows])

  const page = () => Math.max(1, Math.floor((ref.current?.querySelector('.run-body')?.clientHeight ?? 400) / 22) - 1)
  const move = (row: number, col: number) => {
    setCell({ row: Math.max(0, Math.min(row, rows - 1)), col: Math.max(0, Math.min(col, cols - 1)) })
    setCopied(false)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    if (e.key === 'c') onCode()
    else if (!table || rows === 0) return
    else if (rowOpen) {
      if (e.key === 'Escape' || e.key === 'Enter') setRowOpen(false)
      else if (e.key === 'j' || e.key === 'ArrowDown') move(at.row + 1, at.col)
      else if (e.key === 'k' || e.key === 'ArrowUp') move(at.row - 1, at.col)
      else return
    } else if (e.key === 'j' || e.key === 'ArrowDown') move(at.row + 1, at.col)
    else if (e.key === 'k' || e.key === 'ArrowUp') move(at.row - 1, at.col)
    else if (e.key === 'l' || e.key === 'ArrowRight') move(at.row, at.col + 1)
    else if (e.key === 'h' || e.key === 'ArrowLeft') move(at.row, at.col - 1)
    else if (e.key === 'J' || e.key === 'PageDown') move(at.row + page(), at.col)
    else if (e.key === 'K' || e.key === 'PageUp') move(at.row - page(), at.col)
    else if (e.key === 'g') move(0, at.col)
    else if (e.key === 'G') move(rows - 1, at.col)
    else if (e.key === '0') move(at.row, 0)
    else if (e.key === '$') move(at.row, cols - 1)
    else if (e.key === 'Enter') setRowOpen(true)
    else if (e.key === 'y') {
      void navigator.clipboard.writeText(table.rows[at.row]?.[at.col] ?? '').then(() => setCopied(true))
    } else return
    e.preventDefault()
  }

  const value = table?.rows[at.row]?.[at.col] ?? ''
  return (
    <div className="run" ref={ref} tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      {header}
      {!view ? null : view.error ? (
        <div className="status warn">{view.error}</div>
      ) : !table ? (
        <NoResult run={run} status={status} />
      ) : rowOpen ? (
        <div className="run-body record">
          {table.columns.map((name, c) => (
            <div key={c} className={c === at.col ? 'record-field cur' : 'record-field'}>
              <div className="dim">{name}</div>
              <div className="record-value">{table.rows[at.row]?.[c] ?? ''}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="run-body">
          <table className="grid">
            <thead>
              <tr>
                {table.columns.map((name, c) => (
                  <th key={c} className={c === at.col ? 'cur-col' : undefined}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r} className={r === at.row ? 'cur-row' : undefined}>
                  {table.columns.map((_, c) => (
                    <td
                      key={c}
                      className={r === at.row && c === at.col ? 'cur' : undefined}
                      onMouseDown={e => {
                        e.preventDefault()
                        move(r, c)
                        ref.current?.focus()
                      }}
                    >
                      {firstLine(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table && rows > 0 && (
        <div className="cell-detail">
          <div className="dim">
            {rowOpen ? 'row' : table.columns[at.col]} · row {at.row + 1} of {rows}
            {table.truncated ? ' (more in the file)' : ''}
            {copied ? ' · copied' : ''}
          </div>
          {!rowOpen && <div className="cell-value">{value === '' ? <span className="dim">(empty)</span> : value}</div>}
        </div>
      )}
      {table && rows === 0 && <div className="empty">The query returned no rows.</div>}
    </div>
  )
}

/** A cell shows its first line; a multi-line value is marked, and shows in full below the table. */
const firstLine = (text: string) => {
  const cut = text.indexOf('\n')
  return cut < 0 ? text : `${text.slice(0, cut)} ⏎`
}

function CodeTab(props: { header: ReactNode; view: RunView | undefined; status: RunStatus; run: Run; onData: () => void }) {
  const { header, view, run, onData } = props
  return (
    <div
      className="run"
      onKeyDown={e => {
        // The read-only editor is contenteditable, so isPaneKey would refuse every key from it.
        if (e.key === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          onData()
        }
      }}
    >
      {header}
      {!view ? null : view.error ? (
        <div className="status warn">{view.error}</div>
      ) : view.code === undefined ? (
        <div className="empty" tabIndex={-1} data-focus-target>
          This run has no code file.
        </div>
      ) : (
        <CodeView code={view.code} language={run.language} focusKey={String(run.number)} />
      )}
    </div>
  )
}

function History({ runs, current, onChoose }: { runs: Run[]; current: Run | undefined; onChoose: (run: Run) => void }) {
  const newest = [...runs].reverse()
  const [selected, setSelected] = useState(() => Math.max(0, newest.findIndex(r => r.number === current?.number)))
  const index = Math.max(0, Math.min(selected, newest.length - 1))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    if (e.key === 'j' || e.key === 'ArrowDown') setSelected(index + 1)
    else if (e.key === 'k' || e.key === 'ArrowUp') setSelected(Math.max(0, index - 1))
    else if (e.key === 'g') setSelected(0)
    else if (e.key === 'G') setSelected(newest.length - 1)
    else if (e.key === 'Enter') {
      const run = newest[index]
      if (run) onChoose(run)
    } else return
    e.preventDefault()
  }

  if (newest.length === 0) return <Placeholder text="No runs yet." />
  return (
    <div className="list" ref={ref} tabIndex={-1} data-focus-target onKeyDown={onKeyDown} role="listbox" aria-label="Runs">
      {newest.map((run, i) => (
        <div
          key={run.number}
          role="option"
          aria-selected={i === index}
          className={i === index ? 'row sel' : 'row'}
          onMouseDown={e => e.preventDefault()}
          onClick={() => onChoose(run)}
        >
          <b className="run-number">{run.label}</b>
          <span className="grow">{run.slug}</span>
          {run.number === current?.number && <span className="dim">current</span>}
          <span className="dim">{[run.code && (run.language === 'python' ? 'py' : 'sql'), run.data && 'csv'].filter(Boolean).join(' + ')}</span>
        </div>
      ))}
    </div>
  )
}

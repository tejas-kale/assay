import { Fragment, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'

import { markTabs } from '../../core/dataTabs.ts'
import type { MarkedTab, Seen } from '../../core/dataTabs.ts'
import { shortcutLabel } from '../../core/keymap.ts'
import type { CommandId } from '../../core/keymap.ts'
import { canRerun } from '../../core/requests.ts'
import { runLabel, sqlBody } from '../../core/runs.ts'
import type { RunHeader } from '../../core/runs.ts'
import type { Run, RunStatus, RunView } from '../../shared/ipc.ts'
import { CodeEditor, CodeView, formatSql } from './CodeView.tsx'
import type { EditorHandle } from './CodeView.tsx'
import { isPaneKey } from './common.tsx'
import type { DataTabName } from './common.tsx'

export const DATA_TABS: { id: DataTabName; title: string }[] = [
  { id: 'data', title: 'Data' },
  { id: 'plots', title: 'Plots' },
  { id: 'code', title: 'Code' },
  { id: 'history', title: 'History' },
]

/** A command the app sends to the pane: `n` makes a repeat of the same command a new request. */
export type DataCommand = { id: Extract<CommandId, 'pin.toggle' | 'code.edit' | 'code.run'>; n: number }

type Props = {
  tab: DataTabName
  runs: Run[]
  status: RunStatus
  onTab: (tab: DataTabName) => void
  command: DataCommand | undefined
  onToast: (text: string) => void
}

/** The header a run's fields were read from. */
const headerOf = (run: Run): RunHeader => ({
  author: run.author ?? 'claude',
  engine: run.engine ?? 'databricks',
  ...(run.from !== undefined && { from: run.from }),
  ...(run.trusted !== undefined && { trusted: run.trusted }),
})

/** What a run is open for editing: where it came from, and the text it started with. */
type Edit = { from: Run; start: string }

/** The user's reply is not expected after this long: the mod only polls while Claude's session is alive. */
const PICKUP_MS = 10_000

/**
 * Data, Code and History over `queries/`. All show one current run: Claude's latest, unless a run
 * is held (chosen in History, or pinned with `p`). Data links to the run's code and Code links back
 * to its data. Code can edit the run, and Cmd+Enter sends the SQL to the mod as a new run.
 */
export function DataPane({ tab, runs, status, onTab, command, onToast }: Props) {
  const [held, setHeld] = useState<number>()
  const [original, setOriginal] = useState(false)
  const [edit, setEdit] = useState<Edit>()
  const [markers, setMarkers] = useState<ReadonlySet<MarkedTab>>(new Set())
  const editText = useRef('')
  const latest = runs.at(-1)
  // A held run that disappears falls back to following.
  const heldRun = runs.find(r => r.number === held)
  const current = heldRun ?? latest
  const following = heldRun === undefined
  const view = useRunView(current, runs)

  const choose = (run: Run) => {
    setHeld(run.number === latest?.number ? undefined : run.number)
    onTab('data')
  }
  // Vim owns the keys while editing, and a pin would change what the edit is about.
  const togglePin = () => {
    if (!edit) setHeld(following ? current?.number : undefined)
  }

  // Tab markers: what changed in the current run since the last state push.
  const seen: Seen = {
    ...(current && { number: current.number }),
    ...(current?.code !== undefined && { code: current.code }),
    ...(current?.data !== undefined && { data: current.data }),
    failed: current ? status.failed[current.number] !== undefined : false,
    runCount: runs.length,
  }
  const before = useRef(seen)
  useEffect(() => {
    setMarkers(m => markTabs(m, before.current, seen, tab))
    before.current = seen
    // `seen` is rebuilt every render; these are the values it reads.
  }, [tab, current?.number, current?.code, current?.data, seen.failed, runs.length])

  // Sending: the reply (or its absence) is reported once per request.
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const latestRef = useRef({ status, runCount: runs.length })
  latestRef.current = { status, runCount: runs.length }
  useEffect(() => {
    const stop = window.app.runs.onReply(reply => {
      const timer = pending.current.get(reply.id)
      if (timer) clearTimeout(timer)
      pending.current.delete(reply.id)
      if ('error' in reply) onToast(`The run was refused: ${reply.error}`)
    })
    return () => {
      stop()
      pending.current.forEach(clearTimeout)
    }
  }, [onToast])

  const send = (run: Run, sql: string) => {
    if (sql.trim() === '') return onToast('Nothing to run: the SQL is empty')
    const reason = canRerun(run, headerOf(run), sql)
    if (reason) return onToast(reason)
    const sentAt = runs.length
    void window.app.runs
      .request({ sql, engine: run.engine ?? 'databricks', from: run.number, slug: run.slug })
      .then(result => {
        if (!result.ok) return onToast(result.message)
        setEdit(undefined)
        setHeld(undefined)
        onToast("Sent to Claude's session…")
        pending.current.set(
          result.id,
          setTimeout(() => {
            pending.current.delete(result.id)
            const now = latestRef.current
            if (!now.status.running && now.runCount === sentAt) {
              onToast('The session has not picked up the run. Is Claude running in this window?')
            }
          }, PICKUP_MS),
        )
      })
  }

  const startEdit = () => {
    if (edit) return
    if (!current || view?.code === undefined) return onToast('No code to edit')
    const reason = canRerun(current, headerOf(current), view.code)
    if (reason || current.language !== 'sql') return onToast(reason ?? 'Only SQL can be edited')
    const body = sqlBody(view.code)
    const start = original ? body : formatSql(body)
    editText.current = start
    setEdit({ from: current, start })
    onTab('code')
  }

  const editor = useRef<EditorHandle>(null)
  const runIt = () => {
    if (edit) return send(edit.from, editor.current?.text() ?? editText.current)
    if (!current || view?.code === undefined) return onToast('No code to run')
    send(current, sqlBody(view.code))
  }

  // The app's commands reach the pane through one request at a time; the latest handlers run them.
  const handlers = useRef({ togglePin, startEdit, runIt })
  handlers.current = { togglePin, startEdit, runIt }
  // A command sent before this pane existed (from the picker) is not for it.
  const firstCommand = useRef(command?.n)
  useEffect(() => {
    if (!command || command.n === firstCommand.current) return
    if (command.id === 'pin.toggle') handlers.current.togglePin()
    else if (command.id === 'code.edit') handlers.current.startEdit()
    else handlers.current.runIt()
    // Only a new request runs a command.
  }, [command?.n])

  const tabs = (
    <div className="tabs" role="tablist">
      {DATA_TABS.map(t => (
        <button key={t.id} role="tab" tabIndex={-1} aria-selected={tab === t.id} onClick={() => onTab(t.id)}>
          {t.title}
          {markers.has(t.id as MarkedTab) && <span className="mark" title="New since you looked" />}
        </button>
      ))}
    </div>
  )

  let body
  if (tab === 'plots') body = <Placeholder text="Plots arrive in slice 3." />
  else if (tab === 'history') body = <History runs={runs} status={status} current={current} onChoose={choose} onPin={togglePin} />
  else if (!current) body = <Placeholder text="No runs yet. Claude's queries appear here." />
  else {
    const header = (
      <RunHeader
        run={edit && tab === 'code' ? edit.from : current}
        status={status}
        pinned={!following}
        editing={edit !== undefined && tab === 'code'}
        onFollow={() => setHeld(undefined)}
      >
        {tab === 'data' ? (
          <LinkButton onClick={() => onTab('code')} label="Code" shortcut={shortcutLabel('tab.code')} />
        ) : (
          <LinkButton onClick={() => onTab('data')} label="Data" shortcut={shortcutLabel('tab.data')} />
        )}
      </RunHeader>
    )
    body =
      tab === 'data' ? (
        <DataTab header={header} view={view} status={status} run={current} onCode={() => onTab('code')} onPin={togglePin} />
      ) : (
        <CodeTab
          header={header}
          view={view}
          run={current}
          onData={() => onTab('data')}
          onPin={togglePin}
          onEdit={startEdit}
          original={original}
          onToggleOriginal={() => setOriginal(v => !v)}
          edit={edit}
          editText={editText}
          editorRef={editor}
          onLeave={() => setEdit(undefined)}
        />
      )
  }
  return (
    <Fragment>
      {tabs}
      {body}
    </Fragment>
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

/** The trust label as the chip Notes uses, then `you` and `from 012` when they apply. */
function RunTags({ run, status }: { run: Run; status: RunStatus }) {
  const label = runLabel(run, headerOf(run), status)
  return (
    <>
      <span className={`chip chip-${label}`}>{label}</span>
      {run.author === 'user' && <span className="chip chip-you">you</span>}
      {run.from !== undefined && <span className="dim">from {String(run.from).padStart(3, '0')}</span>}
    </>
  )
}

function RunHeader(props: {
  run: Run
  status: RunStatus
  pinned: boolean
  editing: boolean
  onFollow: () => void
  children: ReactNode
}) {
  return (
    <div className="run-header">
      <b>{props.run.label}</b>
      <span className="grow run-slug">{props.run.slug}</span>
      <RunTags run={props.run} status={props.status} />
      {props.editing && <span className="editing-flag">editing {props.run.label}</span>}
      {props.pinned && !props.editing && (
        <button type="button" className="run-link" tabIndex={-1} onClick={props.onFollow} title="Follow Claude's latest run">
          pinned · p: follow latest
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
function DataTab(props: {
  header: ReactNode
  view: RunView | undefined
  status: RunStatus
  run: Run
  onCode: () => void
  onPin: () => void
}) {
  const { header, view, status, run, onCode, onPin } = props
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
    else if (e.key === 'p') onPin()
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

function CodeTab(props: {
  header: ReactNode
  view: RunView | undefined
  run: Run
  onData: () => void
  onPin: () => void
  onEdit: () => void
  original: boolean
  onToggleOriginal: () => void
  edit: Edit | undefined
  editText: { current: string }
  editorRef: Ref<EditorHandle>
  onLeave: () => void
}) {
  const { header, view, run, edit, editText } = props
  const [confirm, setConfirm] = useState(false)
  // The editor starts from the text held so far, so coming back to the tab keeps the edit.
  const [resume] = useState(() => editText.current)

  const leave = () => {
    if (editText.current === edit?.start) props.onLeave()
    else setConfirm(true)
  }
  const handle = props.editorRef as { current: EditorHandle | null }

  return (
    <div
      className="run"
      onKeyDownCapture={e => {
        if (!edit) return
        // Esc in Vim normal mode leaves; elsewhere Vim takes it (insert and visual go back to normal).
        if (confirm) {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'y') props.onLeave()
          if (e.key === 'y' || e.key === 'n' || e.key === 'Escape') setConfirm(false)
        } else if (e.key === 'Escape' && handle.current?.atRest()) {
          e.preventDefault()
          e.stopPropagation()
          leave()
        }
      }}
      onKeyDown={e => {
        // The editor is contenteditable, so isPaneKey would refuse every key from it.
        if (edit || e.metaKey || e.ctrlKey || e.altKey) return
        if (e.key === 'd') props.onData()
        else if (e.key === 'p') props.onPin()
        else if (e.key === 'i') props.onEdit()
        else return
        e.preventDefault()
      }}
    >
      {header}
      {confirm && <div className="status warn">Discard edits? y / n</div>}
      {edit ? (
        <CodeEditor key={edit.from.number} initial={resume} onChange={text => (editText.current = text)} handleRef={props.editorRef} />
      ) : !view ? null : view.error ? (
        <div className="status warn">{view.error}</div>
      ) : view.code === undefined ? (
        <div className="empty" tabIndex={-1} data-focus-target>
          This run has no code file.
        </div>
      ) : (
        <CodeView
          code={view.code}
          language={run.language}
          focusKey={String(run.number)}
          original={props.original}
          onToggleOriginal={props.onToggleOriginal}
        />
      )}
    </div>
  )
}

function History(props: {
  runs: Run[]
  status: RunStatus
  current: Run | undefined
  onChoose: (run: Run) => void
  onPin: () => void
}) {
  const { runs, status, current, onChoose, onPin } = props
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
    else if (e.key === 'p') onPin()
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
          <RunTags run={run} status={status} />
          {run.number === current?.number && <span className="dim">current</span>}
          <span className="dim">{[run.code && (run.language === 'python' ? 'py' : 'sql'), run.data && 'csv'].filter(Boolean).join(' + ')}</span>
        </div>
      ))}
    </div>
  )
}

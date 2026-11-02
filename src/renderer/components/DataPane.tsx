import { Fragment, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'

import { markTabs } from '../../core/dataTabs.ts'
import type { Seen } from '../../core/dataTabs.ts'
import { shortcutLabel } from '../../core/keymap.ts'
import type { CommandId } from '../../core/keymap.ts'
import { canRerun } from '../../core/requests.ts'
import { chosenRuns, confirmText, initReplay, replayKey } from '../../core/replay.ts'
import type { ReplayState } from '../../core/replay.ts'
import { codeBody, runLabel } from '../../core/runs.ts'
import type { RunHeader } from '../../core/runs.ts'
import type { Run, RunRequest, RunStatus, RunView, TrustReview } from '../../shared/ipc.ts'
import { CodeEditor, CodeView, formatSql } from './CodeView.tsx'
import type { EditorHandle } from './CodeView.tsx'
import { isPaneKey } from './common.tsx'
import { TrustTab } from './TrustTab.tsx'
import type { DataTabName } from './common.tsx'

export const DATA_TABS: { id: DataTabName; title: string }[] = [
  { id: 'data', title: 'Data' },
  { id: 'plots', title: 'Plots' },
  { id: 'code', title: 'Code' },
  { id: 'history', title: 'History' },
  { id: 'trust', title: 'Trust' },
]

/** A command the app sends to the pane: `n` makes a repeat of the same command a new request. */
export type DataCommand = { n: number } & (
  | { id: Extract<CommandId, 'pin.toggle' | 'code.edit' | 'code.run' | 'run.interrupt' | 'kernel.restart' | 'replay.open'> }
  /** Hold run `number`, as choosing it in History does (a followed citation in a note). */
  | { id: 'run.show'; number: number }
)

type Props = {
  tab: DataTabName
  runs: Run[]
  status: RunStatus
  trust?: TrustReview | undefined
  onTab: (tab: DataTabName) => void
  command: DataCommand | undefined
  onToast: (text: string) => void
}

/** The header a run's fields were read from. */
const headerOf = (run: Run): RunHeader => ({
  author: run.author ?? 'claude',
  engine: run.engine ?? 'databricks',
  ...(run.from !== undefined && { from: run.from }),
  ...(run.replay !== undefined && { replay: run.replay }),
  ...(run.trusted !== undefined && { trusted: run.trusted }),
})

/** What a run is open for editing: where it came from, and the text it started with. */
type Edit = { id: number; from: Run; start: string }

/** The user's reply is not expected after this long: the mod only polls while Claude's session is alive. */
const PICKUP_MS = 10_000

type Pending = { kind: RunRequest['kind']; timer: ReturnType<typeof setTimeout> }
const DONE_TEXT = { interrupt: 'Interrupted.', restart: 'Kernel restarted.', replay: 'Replay finished.' }

/** Puts the keyboard back on the data pane's current target (after a prompt or a view went away). */
const focusDataPane = () =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-pane="data"] [data-focus-target]')?.focus())

/**
 * Data, Plots, Code and History over `queries/`. All show one current run: Claude's latest, unless a run
 * is held (chosen in History, or pinned with `p`). Data links to the run's code and Code links back
 * to its data. Code can edit the run, and Cmd+Enter sends the code to the mod as a new run.
 * Python runs add table switching and a stdout view to Data, the Plots tab, the kernel restart
 * prompt and the Replay view.
 */
export function DataPane({ tab, runs, status, trust, onTab, command, onToast }: Props) {
  const [held, setHeld] = useState<number>()
  const [original, setOriginal] = useState(false)
  const [edit, setEdit] = useState<Edit>()
  const [markers, setMarkers] = useState<ReadonlySet<string>>(new Set())
  const [tableK, setTableK] = useState(1)
  const [plotK, setPlotK] = useState(1)
  const [textOverride, setTextOverride] = useState<boolean>()
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [replay, setReplay] = useState<{ state: ReplayState; back: DataTabName }>()
  const editText = useRef('')
  const editCount = useRef(0)
  const latest = runs.at(-1)
  // A held run that disappears falls back to following.
  const heldRun = runs.find(r => r.number === held)
  const current = heldRun ?? latest
  const following = heldRun === undefined
  const isPython = current?.language === 'python'
  const tableCount = current?.tables.length ?? 0
  const plotCount = current?.plots.length ?? 0
  const k = Math.max(1, Math.min(tableK, tableCount))
  const plot = Math.max(1, Math.min(plotK, plotCount))
  // A Python run with no table opens on its text: stdout and the error.
  const textView = isPython && (textOverride ?? tableCount === 0)
  const view = useRunView(current, runs, k)

  // A new run starts at its first table and plot, on the view its content calls for.
  useEffect(() => {
    setTableK(1)
    setPlotK(1)
    setTextOverride(undefined)
  }, [current?.number])

  const choose = (run: Run) => {
    setHeld(run.number === latest?.number ? undefined : run.number)
    onTab('data')
  }
  // Vim owns the keys while editing, and a pin would change what the edit is about.
  const togglePin = () => {
    if (!edit) setHeld(following ? current?.number : undefined)
  }

  // Leaving an edit unmounts the focused editor: give the pane its keys back, unless focus moved elsewhere.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !edit && document.activeElement === document.body) focusDataPane()
    wasEditing.current = edit !== undefined
  }, [edit])

  // Tab markers: what changed in the current run since the last state push.
  // A SQL run's result is its csv; a Python run's is its status and tables, so finishing marks Data too.
  const resultKey = current?.data ?? (current?.result ? `${current.status ?? ''}:${tableCount}` : undefined)
  const seen: Seen = {
    ...(current && { number: current.number }),
    ...(current?.code !== undefined && { code: current.code }),
    ...(resultKey !== undefined && { data: resultKey }),
    plots: current?.plots ?? [],
    failed: current ? status.failed[current.number] !== undefined : false,
    runCount: runs.length,
    ...(trust && { trust: `${trust.startedAt}:${trust.state}:${trust.steps.length}:${trust.sample?.rows.length ?? 0}` }),
  }
  const before = useRef(seen)
  useEffect(() => {
    setMarkers(m => markTabs(m, before.current, seen, tab))
    before.current = seen
    // `seen` is rebuilt every render; these are the values it reads.
  }, [tab, current?.number, current?.code, current?.data, current?.status, tableCount, current?.plots.join('\n'), seen.failed, runs.length, seen.trust])

  // Sending: the reply (or its absence) is reported once per request.
  const pending = useRef(new Map<string, Pending>())
  const latestRef = useRef({ status, runCount: runs.length })
  latestRef.current = { status, runCount: runs.length }
  useEffect(() => {
    const stop = window.app.runs.onReply(reply => {
      const sent = pending.current.get(reply.id)
      if (sent) clearTimeout(sent.timer)
      pending.current.delete(reply.id)
      const kind = sent?.kind
      if ('error' in reply) onToast(kind === 'interrupt' || kind === 'restart' || kind === 'replay' ? reply.error : `The run was refused: ${reply.error}`)
      else if ('ok' in reply && kind && kind !== 'sql' && kind !== 'python') onToast(DONE_TEXT[kind])
    })
    return () => {
      stop()
      pending.current.forEach(p => clearTimeout(p.timer))
    }
  }, [onToast])

  /** Writes a request, then reports once whether the session picked it up. `onSent` runs when the file is written. */
  const sendRequest = (request: RunRequest, onSent?: () => void) => {
    const sentAt = runs.length
    void window.app.runs.request(request).then(result => {
      if (!result.ok) return onToast(result.message)
      onSent?.()
      onToast("Sent to Claude's session…")
      const id = result.id
      pending.current.set(id, {
        kind: request.kind,
        timer: setTimeout(() => {
          pending.current.delete(id)
          const now = latestRef.current
          if (!now.status.running && now.runCount === sentAt && now.status.kernel?.state !== 'starting') {
            onToast('The session has not picked up the request. Is Claude running in this window?')
          }
        }, PICKUP_MS),
      })
    })
  }

  const send = (run: Run, code: string) => {
    const python = run.language === 'python'
    if (code.trim() === '') return onToast(`Nothing to run: the ${python ? 'code' : 'SQL'} is empty`)
    const reason = canRerun(run, headerOf(run), code)
    if (reason) return onToast(reason)
    const origin = { from: run.number, slug: run.slug }
    sendRequest(
      python ? { kind: 'python', code, ...origin } : { kind: 'sql', sql: code, engine: run.engine ?? 'databricks', ...origin },
      () => {
        setEdit(undefined)
        setHeld(undefined)
      },
    )
  }

  const startEdit = () => {
    // Already editing: only bring the open editor forward, keeping its text.
    if (edit) return onTab('code')
    if (!current || view?.code === undefined) return onToast('No code to edit')
    if (current.language === undefined) return onToast('No code to edit')
    const reason = canRerun(current, headerOf(current), view.code)
    if (reason) return onToast(reason)
    const body = codeBody(view.code, current.language)
    const start = current.language === 'sql' && !original ? formatSql(body) : body
    editText.current = start
    setEdit({ id: ++editCount.current, from: current, start })
    onTab('code')
  }

  const editor = useRef<EditorHandle>(null)
  const runIt = () => {
    if (edit) return send(edit.from, editor.current?.text() ?? editText.current)
    if (!current || view?.code === undefined || current.language === undefined) return onToast('No code to run')
    send(current, codeBody(view.code, current.language))
  }

  const openReplay = () => {
    const python = runs.filter(r => r.language === 'python')
    if (python.length === 0) return onToast('No Python runs to replay.')
    setConfirmRestart(false)
    setReplay({ state: initReplay(python), back: tab })
  }
  const closeReplay = () => {
    setReplay(undefined)
    focusDataPane()
  }
  const onReplayKey = (key: string) => {
    if (!replay) return
    const next = replayKey(replay.state, key)
    if (next.effect?.type === 'leave') return closeReplay()
    if (next.effect?.type === 'send') {
      const { back } = replay
      return sendRequest({ kind: 'replay', runs: next.effect.runs }, () => {
        setReplay(undefined)
        setHeld(undefined)
        onTab(back)
        focusDataPane()
      })
    }
    setReplay({ ...replay, state: next.state })
  }
  const answerRestart = (key: string) => {
    if (key !== 'y' && key !== 'n' && key !== 'Escape') return
    setConfirmRestart(false)
    focusDataPane()
    if (key === 'y') sendRequest({ kind: 'restart' })
  }

  // The app's commands reach the pane through one request at a time; the latest handlers run them.
  const showRun = (number: number) => {
    const run = runs.find(r => r.number === number)
    if (run) choose(run)
    else onToast(`No run ${String(number).padStart(3, '0')}`)
  }
  const handlers = useRef({ togglePin, startEdit, runIt, openReplay, showRun })
  handlers.current = { togglePin, startEdit, runIt, openReplay, showRun }
  // A command sent before this pane existed (from the picker) is not for it.
  const firstCommand = useRef(command?.n)
  useEffect(() => {
    if (!command || command.n === firstCommand.current) return
    if (command.id === 'pin.toggle') handlers.current.togglePin()
    else if (command.id === 'code.edit') handlers.current.startEdit()
    else if (command.id === 'code.run') handlers.current.runIt()
    else if (command.id === 'run.interrupt') sendRequest({ kind: 'interrupt' })
    else if (command.id === 'kernel.restart') setConfirmRestart(true)
    else if (command.id === 'run.show') handlers.current.showRun(command.number)
    else handlers.current.openReplay()
    // Only a new request runs a command.
  }, [command?.n])

  const tabs = (
    <div className="tabs" role="tablist">
      {DATA_TABS.map(t => (
        <button
          key={t.id}
          role="tab"
          tabIndex={-1}
          aria-selected={tab === t.id && !replay}
          onClick={() => {
            setReplay(undefined)
            onTab(t.id)
          }}
        >
          {t.title}
          {markers.has(t.id) && <span className="mark" title="New since you looked" />}
        </button>
      ))}
    </div>
  )

  const kernel = status.kernel
  const prompt = confirmRestart && (
    <Prompt text="Restart the kernel? Its variables are lost. y / n" onKey={answerRestart} />
  )

  let body
  if (replay) body = <ReplayView state={replay.state} onKey={onReplayKey} />
  else if (tab === 'trust') body = <TrustTab review={trust} />
  else if (tab === 'history') body = <History runs={runs} status={status} current={current} onChoose={choose} onPin={togglePin} />
  else if (!current) body = <Placeholder text="No runs yet. Claude's queries appear here." />
  else {
    const note =
      tab === 'data' && isPython && !textView && tableCount > 0 ? (
        <span className="dim">
          table {k} of {tableCount}
        </span>
      ) : tab === 'plots' && plotCount > 0 ? (
        <span className="dim">
          plot {plot} of {plotCount}
        </span>
      ) : null
    const header = (
      <>
        <RunHeader
          run={edit && tab === 'code' ? edit.from : current}
          status={status}
          pinned={!following}
          editing={edit !== undefined && tab === 'code'}
          onFollow={() => setHeld(undefined)}
        >
          {note}
          {kernel && (
            <span className={`kernel-state kernel-${kernel.state}`} title={kernel.message}>
              kernel {kernel.state}
            </span>
          )}
          {tab === 'code' ? (
            <LinkButton onClick={() => onTab('data')} label="Data" shortcut={shortcutLabel('tab.data')} />
          ) : (
            <LinkButton onClick={() => onTab('code')} label="Code" shortcut={shortcutLabel('tab.code')} />
          )}
        </RunHeader>
        {kernel && (kernel.state === 'missing' || kernel.state === 'dead') && kernel.message && (
          <div className="status warn">{kernel.message}</div>
        )}
      </>
    )
    body =
      tab === 'data' ? (
        <DataTab
          header={header}
          view={view}
          status={status}
          run={current}
          textView={textView}
          tableCount={tableCount}
          onToggleText={() => setTextOverride(!textView)}
          onTable={delta => setTableK(Math.max(1, Math.min(k + delta, tableCount)))}
          onCode={() => onTab('code')}
          onPin={togglePin}
        />
      ) : tab === 'plots' ? (
        <PlotsTab
          header={header}
          run={current}
          runs={runs}
          plot={plot}
          plotCount={plotCount}
          onPlot={delta => setPlotK(Math.max(1, Math.min(plot + delta, plotCount)))}
          onCode={() => onTab('code')}
          onPin={togglePin}
        />
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
      {prompt}
      {body}
    </Fragment>
  )
}

/** Reads the current run, again whenever the runs change (a result may land after its code). */
function useRunView(run: Run | undefined, runs: Run[], table: number): RunView | undefined {
  const [view, setView] = useState<RunView>()
  const key = run ? `${run.number}:${run.code ?? ''}:${run.data ?? ''}:${table}` : ''
  useEffect(() => {
    if (!run) {
      setView(undefined)
      return
    }
    let live = true
    void window.app.readRun(run.number, { table }).then(v => {
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
      {run.replay !== undefined && <span className="dim">replay of {String(run.replay).padStart(3, '0')}</span>}
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
  const noun = run.language === 'python' ? 'Run' : 'Query'
  if (status.running?.number === run.number) {
    const seconds = Math.max(0, Math.round((now - status.running.startedAt) / 1000))
    return <div className="empty running">{noun} {run.label} is running… {seconds} s</div>
  }
  const failed = status.failed[run.number]
  if (failed !== undefined) return <pre className="status warn run-error">{noun} {run.label} failed:{'\n'}{failed}</pre>
  return <div className="empty">No result saved for {noun.toLowerCase()} {run.label}. It may have failed in an earlier session.</div>
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
  /** Python runs: show stdout and the error instead of a table. */
  textView: boolean
  tableCount: number
  onToggleText: () => void
  onTable: (delta: 1 | -1) => void
  onCode: () => void
  onPin: () => void
}) {
  const { header, view, status, run, textView, tableCount, onToggleText, onTable, onCode, onPin } = props
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
    const python = run.language === 'python'
    if (e.key === 'c') onCode()
    else if (e.key === 'p') onPin()
    else if (python && e.key === 's') onToggleText()
    else if (python && !textView && tableCount > 1 && (e.key === '[' || e.key === ']')) onTable(e.key === ']' ? 1 : -1)
    else if (textView) {
      const body = ref.current?.querySelector('.run-body')
      if (!body) return
      if (e.key === 'j' || e.key === 'ArrowDown') body.scrollBy({ top: 44 })
      else if (e.key === 'k' || e.key === 'ArrowUp') body.scrollBy({ top: -44 })
      else if (e.key === 'J' || e.key === 'PageDown') body.scrollBy({ top: body.clientHeight - 22 })
      else if (e.key === 'K' || e.key === 'PageUp') body.scrollBy({ top: 22 - body.clientHeight })
      else if (e.key === 'g') body.scrollTo({ top: 0 })
      else if (e.key === 'G') body.scrollTo({ top: body.scrollHeight })
      else return
    } else if (!table || rows === 0) return
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
      ) : textView ? (
        <TextView run={run} view={view} status={status} />
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
      {!textView && table && rows > 0 && (
        <div className="cell-detail">
          <div className="dim">
            {rowOpen ? 'row' : table.columns[at.col]} · row {at.row + 1} of {rows}
            {table.truncated ? ' (more in the file)' : ''}
            {copied ? ' · copied' : ''}
          </div>
          {!rowOpen && <div className="cell-value">{value === '' ? <span className="dim">(empty)</span> : value}</div>}
        </div>
      )}
      {!textView && table && rows === 0 && <div className="empty">{run.language === 'python' ? 'The table has no rows.' : 'The query returned no rows.'}</div>}
    </div>
  )
}

/** A Python run's stdout and error: the whole text view, updated on every state push while it runs. */
function TextView({ run, view, status }: { run: Run; view: RunView; status: RunStatus }) {
  const result = view.result
  const running = status.running?.number === run.number
  const now = useNow(running)
  if (!result) return <NoResult run={run} status={status} />
  const seconds = running && status.running ? Math.max(0, Math.round((now - status.running.startedAt) / 1000)) : undefined
  const { error } = result
  return (
    <div className="run-body">
      {seconds !== undefined && <div className="empty running">Run {run.label} is running… {seconds} s</div>}
      {result.status === 'running' && !running && <div className="empty">Run {run.label} is marked running but the session is not running it: it was cut off.</div>}
      {result.status === 'interrupted' && <div className="status warn">Run {run.label} was interrupted.</div>}
      {result.stdout !== '' && <pre className="run-text">{result.stdout}</pre>}
      {result.stdoutTruncated && <div className="dim run-text">(output cut at 1 MB)</div>}
      {error && (
        <pre className="run-text traceback">
          {error.name}: {error.message}
          {error.traceback !== '' && `\n\n${error.traceback}`}
        </pre>
      )}
      {result.stdout === '' && !error && !running && result.status === 'ok' && <div className="empty">No output.</div>}
    </div>
  )
}

/** One line that holds the keys until answered: y, n or Escape. */
function Prompt({ text, onKey }: { text: string; onKey: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div
      className="status warn"
      ref={ref}
      tabIndex={-1}
      data-focus-target
      onKeyDown={e => {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        onKey(e.key)
      }}
    >
      {text}
    </div>
  )
}

/** The Replay view: Python runs oldest first, with a cursor and check marks. The keys are in core/replay.ts. */
function ReplayView({ state, onKey }: { state: ReplayState; onKey: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [state.cursor])
  const n = chosenRuns(state).length
  return (
    <div
      className="list"
      ref={ref}
      tabIndex={-1}
      data-focus-target
      role="listbox"
      aria-label="Replay"
      onKeyDown={e => {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        onKey(e.key)
      }}
    >
      {state.mode === 'confirm' ? (
        <div className="status warn">{confirmText(state)}</div>
      ) : (
        <div className="status replay-state">
          Replay: {n} of {state.runs.length} chosen · space choose · a all/none · Enter replay · Esc leave
        </div>
      )}
      {state.runs.map((run, i) => (
        <div key={run.number} role="option" aria-selected={i === state.cursor} className={i === state.cursor ? 'row sel' : 'row'}>
          <span>{state.chosen.has(run.number) ? '[x]' : '[ ]'}</span>
          <b className="run-number">{run.label}</b>
          <span className="grow">{run.slug}</span>
          {run.status && run.status !== 'ok' && <span className="chip chip-unverified">{run.status}</span>}
          {run.replay !== undefined && <span className="dim">replay of {String(run.replay).padStart(3, '0')}</span>}
        </div>
      ))}
    </div>
  )
}

/** The current run's plots, one at a time and fit to the pane. `j` and `k` move between them. */
function PlotsTab(props: {
  header: ReactNode
  run: Run
  runs: Run[]
  plot: number
  plotCount: number
  onPlot: (delta: 1 | -1) => void
  onCode: () => void
  onPin: () => void
}) {
  const { header, run, runs, plot, onPlot, onCode, onPin } = props
  const file = run.plots[plot - 1]
  const [shown, setShown] = useState<{ file: string; url?: string; message?: string }>()
  const failed = shown !== undefined && shown.file === file && shown.url === undefined
  useEffect(() => {
    if (file === undefined) return
    let live = true
    void window.app.readPlot(run.number, plot).then(result => {
      if (live) setShown(result.ok ? { file, url: result.dataUrl } : { file, message: result.message })
    })
    return () => {
      live = false
    }
    // A plot that could not be read yet is tried again on each state push; a read one is not.
  }, [run.number, plot, file, failed ? runs : null])

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    if (e.key === 'c') onCode()
    else if (e.key === 'p') onPin()
    else if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'l' || e.key === 'ArrowRight') onPlot(1)
    else if (e.key === 'k' || e.key === 'ArrowUp' || e.key === 'h' || e.key === 'ArrowLeft') onPlot(-1)
    else return
    e.preventDefault()
  }

  return (
    <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      {header}
      {run.language !== 'python' ? (
        <div className="empty">SQL runs have no plots.</div>
      ) : file === undefined ? (
        <div className="empty">Run {run.label} has no plots.</div>
      ) : shown?.file === file && shown.url ? (
        <div className="plot-frame">
          <img src={shown.url} alt={`Plot ${plot} of run ${run.label}`} />
        </div>
      ) : shown && shown.file === file ? (
        <div className="status warn">{shown.message}</div>
      ) : (
        <div className="empty">Loading the plot…</div>
      )}
    </div>
  )
}

/** A cell shows its first line; a multi-line value is marked, and shows in full below the table. */
const firstLine = (text: string) => {
  const cut = text.indexOf('\n')
  return cut < 0 ? text : `${text.slice(0, cut)} ⏎`
}

/** Starts the editor from the text held when it mounts: a new edit's start, or what was typed before a tab switch. */
function EditorHost(props: { language: 'sql' | 'python'; editText: { current: string }; handleRef: RefObject<EditorHandle | null> }) {
  const [initial] = useState(() => props.editText.current)
  return <CodeEditor initial={initial} language={props.language} onChange={text => (props.editText.current = text)} handleRef={props.handleRef} />
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
  editorRef: RefObject<EditorHandle | null>
  onLeave: () => void
}) {
  const { header, view, run, edit, editText } = props
  const [confirm, setConfirm] = useState(false)

  const leave = () => {
    if (editText.current === edit?.start) props.onLeave()
    else setConfirm(true)
  }
  const handle = props.editorRef

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
        <EditorHost key={edit.id} language={edit.from.language ?? 'sql'} editText={editText} handleRef={props.editorRef} />
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
          <span className="dim">{[
              run.code && (run.language === 'python' ? 'py' : 'sql'),
              run.data && 'csv',
              run.tables.length > 0 && `${run.tables.length} table${run.tables.length === 1 ? '' : 's'}`,
              run.plots.length > 0 && `${run.plots.length} plot${run.plots.length === 1 ? '' : 's'}`,
            ]
              .filter(Boolean)
              .join(' + ')}</span>
        </div>
      ))}
    </div>
  )
}

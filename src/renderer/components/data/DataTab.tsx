import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'

import { clampCell, gridKey, LINE_PX, runKey, textScroll } from '../../../core/dataPane.ts'
import type { Cell } from '../../../core/dataPane.ts'
import type { Run, RunStatus, RunView } from '../../../shared/ipc.ts'
import { isPaneKey } from '../common.tsx'
import { NoResult, TextView } from './RunText.tsx'
import type { RunActions } from './RunHeader.tsx'

type Table = NonNullable<RunView['table']>

/** The cursor of one run's table; a run that is not `run` starts at its first cell. */
type Cursor = { run: number; cell: Cell; rowOpen: boolean; copied: boolean }
const fresh = (run: number): Cursor => ({ run, cell: { row: 0, col: 0 }, rowOpen: false, copied: false })

/** Rows a page holds, from the table's height on screen. */
const pageRows = (root: HTMLElement | null) =>
  Math.max(1, Math.floor((root?.querySelector('.run-body')?.clientHeight ?? 400) / LINE_PX) - 1)

/** A cell shows its first line; a multi-line value is marked, and shows in full below the table. */
const firstLine = (text: string) => {
  const cut = text.indexOf('\n')
  return cut < 0 ? text : `${text.slice(0, cut)} ⏎`
}

export function doRunKey(key: string, actions: RunActions): boolean {
  const action = runKey(key)
  if (action?.kind === 'code') actions.onCode()
  else if (action?.kind === 'pin') actions.onPin()
  else if (action?.kind === 'step') actions.onStep(action.delta)
  return action !== undefined
}

export type DataTabProps = Readonly<{
  header: ReactNode
  view: RunView | undefined
  status: RunStatus
  run: Run
  /** Python runs: show stdout and the error instead of a table. */
  textView: boolean
  tableCount: number
  onToggleText: () => void
  onTable: (delta: 1 | -1) => void
  actions: RunActions
}>

/**
 * The result table with a cell cursor: h/j/k/l move, J/K a page, g/G first/last row, 0/$ first/last
 * column. The selected cell's full value shows below the table; Enter shows the whole row; y copies.
 */
export function DataTab(props: DataTabProps) {
  const { header, view, run, textView } = props
  const table = view?.table
  const ref = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState(() => fresh(run.number))
  // Another run starts at its first cell, and coming back to this one does too.
  if (cursor.run !== run.number) setCursor(fresh(run.number))
  const rows = table?.rows.length ?? 0
  const cols = table?.columns.length ?? 0
  const at = clampCell(cursor.cell, rows, cols)
  useEffect(() => {
    ref.current?.querySelector('td.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [at.row, at.col, rows])

  const update = (change: Partial<Cursor>) => {
    // A change for a run no longer shown (a copy that lands late) is dropped.
    setCursor(before => (before.run === run.number ? { ...before, ...change } : before))
  }
  const keys = { ...props, ref, at, rows, cursor, update }
  return (
    <div className="run" ref={ref} tabIndex={-1} data-focus-target onKeyDown={e => { onDataKey(e, keys) }}>
      {header}
      <DataBody {...props} at={at} rowOpen={cursor.rowOpen} onCell={cell => { update({ cell, copied: false }); ref.current?.focus() }} />
      {!textView && table && rows > 0 && <CellDetail table={table} at={at} rowOpen={cursor.rowOpen} copied={cursor.copied} />}
      {!textView && table && rows === 0 && <div className="empty">{run.language === 'python' ? 'The table has no rows.' : 'The query returned no rows.'}</div>}
    </div>
  )
}

type DataKeys = DataTabProps & {
  ref: RefObject<HTMLDivElement | null>
  at: Cell
  rows: number
  cursor: Cursor
  update: (change: Partial<Cursor>) => void
}

function onDataKey(e: KeyboardEvent, keys: DataKeys) {
  if (!isPaneKey(e)) return
  if (dataKey(e.key, keys)) e.preventDefault()
}

/** Whether the Data tab used `key`: the run keys, `s` and `[`/`]` for a Python run, then the text or the table. */
function dataKey(key: string, keys: DataKeys): boolean {
  const python = keys.run.language === 'python'
  if (doRunKey(key, keys.actions)) return true
  if (python && key === 's') {
    keys.onToggleText()
    return true
  }
  if (python && !keys.textView && keys.tableCount > 1 && (key === '[' || key === ']')) {
    keys.onTable(key === ']' ? 1 : -1)
    return true
  }
  if (keys.textView) return scrollText(key, keys.ref.current?.querySelector('.run-body'))
  const table = keys.view?.table
  return table !== undefined && keys.rows > 0 && tableKey(key, table, keys)
}

function scrollText(key: string, body: Element | null | undefined): boolean {
  if (!body) return false
  const scroll = textScroll(key, { height: body.clientHeight, scrollHeight: body.scrollHeight })
  if (scroll && 'by' in scroll) body.scrollBy({ top: scroll.by })
  else if (scroll) body.scrollTo({ top: scroll.to })
  return scroll !== undefined
}

function tableKey(key: string, table: Table, keys: DataKeys): boolean {
  const { at, cursor, update } = keys
  const action = gridKey(key, { at, rowOpen: cursor.rowOpen, rows: keys.rows, cols: table.columns.length, page: pageRows(keys.ref.current) })
  if (action?.kind === 'move') update({ cell: action.cell, copied: false })
  else if (action?.kind === 'open') update({ rowOpen: action.open })
  else if (action?.kind === 'copy') {
    void navigator.clipboard.writeText(table.rows[at.row]?.[at.col] ?? '').then(() => {
      update({ copied: true })
    })
  }
  return action !== undefined
}

function DataBody(props: DataTabProps & Readonly<{ at: Cell; rowOpen: boolean; onCell: (cell: Cell) => void }>) {
  const { view, run, status } = props
  if (!view) return null
  if (view.error) return <div className="status warn">{view.error}</div>
  if (props.textView) return <TextView run={run} view={view} status={status} />
  if (!view.table) return <NoResult run={run} status={status} />
  if (props.rowOpen) return <RecordView table={view.table} at={props.at} />
  return <TableGrid table={view.table} at={props.at} onCell={props.onCell} />
}

function RecordView({ table, at }: Readonly<{ table: Table; at: Cell }>) {
  return (
    <div className="run-body record">
      {table.columns.map((name, c) => (
        <div key={c} className={c === at.col ? 'record-field cur' : 'record-field'}>
          <div className="dim">{name}</div>
          <div className="record-value">{table.rows[at.row]?.[c] ?? ''}</div>
        </div>
      ))}
    </div>
  )
}

function TableGrid({ table, at, onCell }: Readonly<{ table: Table; at: Cell; onCell: (cell: Cell) => void }>) {
  return (
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
                    onCell({ row: r, col: c })
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
  )
}

function CellDetail(props: Readonly<{ table: Table; at: Cell; rowOpen: boolean; copied: boolean }>) {
  const { table, at, rowOpen } = props
  const value = table.rows[at.row]?.[at.col] ?? ''
  return (
    <div className="cell-detail">
      <div className="dim">
        {rowOpen ? 'row' : table.columns[at.col]} · row {at.row + 1} of {table.rows.length}
        {table.truncated ? ' (more in the file)' : ''}
        {props.copied ? ' · copied' : ''}
      </div>
      {!rowOpen && <div className="cell-value">{value === '' ? <span className="dim">(empty)</span> : value}</div>}
    </div>
  )
}

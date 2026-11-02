import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import type { CitationLabel } from '../../shared/ipc.ts'
import type { RunView } from '../../shared/ipc.ts'
import { Preview } from './Preview.tsx'

const ROWS = 30

/**
 * A run of another analysis, read only: its code (highlighted) over its result, a table or a Python run's
 * output. Esc, Tab or q closes it.
 */
export function CitedRunPopup(props: { title: string; label: CitationLabel | undefined; view: RunView; onClose: () => void }) {
  const { view } = props
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!box.current?.contains(document.activeElement)) box.current?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [])
  const language = view.run.language === 'python' ? 'python' : 'sql'
  const { table, result } = view
  return createPortal(
    <div className="overlay" onMouseDown={props.onClose}>
      <div
        className="palette cited-run"
        role="dialog"
        aria-modal="true"
        aria-label="Cited run"
        tabIndex={-1}
        ref={box}
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.metaKey || e.ctrlKey || e.altKey) return
          if (e.key === 'Escape' || e.key === 'Tab' || e.key === 'q') {
            e.preventDefault()
            e.stopPropagation()
            props.onClose()
          }
        }}
      >
        <div className="subhead">
          {props.title} {props.label && <span className={`chip chip-${props.label}`}>{props.label}</span>}
        </div>
        {view.error && <div className="status warn">{view.error}</div>}
        <Preview source={view.code === undefined ? undefined : { type: 'text', text: view.code, language }} focus />
        <div className="cited-result">
          {table ? (
            <table className="grid">
              <thead>
                <tr>{table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.slice(0, ROWS).map((row, r) => (
                  <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          ) : result ? (
            <pre>{result.error ? `${result.error.name}: ${result.error.message}` : result.stdout || `Status: ${result.status}`}</pre>
          ) : (
            <div className="empty">No result saved for this run.</div>
          )}
          {table && (table.truncated || table.rows.length > ROWS) && <div className="status dim">First {Math.min(ROWS, table.rows.length)} rows shown.</div>}
        </div>
        <div className="hint">h j k l · w b · g G move · Esc / Tab / q close</div>
      </div>
    </div>,
    document.body,
  )
}

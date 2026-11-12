import { useRef } from 'react'
import { createPortal } from 'react-dom'

import type { CitationLabel } from '../../shared/ipc.ts'
import type { RunView } from '../../shared/ipc.ts'
import { closeOnKeys, useFocusOnOpen } from './popup.ts'
import { Preview } from './Preview.tsx'

const ROWS = 30

type Props = Readonly<{ title: string; label: CitationLabel | undefined; view: RunView; onClose: () => void }>

/** What the run produced: a table (its first rows), a Python run's output, or a note that nothing was saved. */
function CitedResult({ view }: Readonly<{ view: RunView }>) {
  const { table, result } = view
  if (table) {
    return (
      <>
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
        {(table.truncated || table.rows.length > ROWS) && <div className="status dim">First {Math.min(ROWS, table.rows.length)} rows shown.</div>}
      </>
    )
  }
  if (!result) return <div className="empty">No result saved for this run.</div>
  return <pre>{result.error ? `${result.error.name}: ${result.error.message}` : result.stdout || `Status: ${result.status}`}</pre>
}

/**
 * A run of another analysis, read only: its code (highlighted) over its result, a table or a Python run's
 * output. Esc, Tab or q closes it.
 */
export function CitedRunPopup({ title, label, view, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null)
  useFocusOnOpen(box)
  const language = view.run.language === 'python' ? 'python' : 'sql'
  return createPortal(
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="palette cited-run"
        role="dialog"
        aria-modal="true"
        aria-label="Cited run"
        tabIndex={-1}
        ref={box}
        onMouseDown={e => {
          e.stopPropagation()
        }}
        onKeyDown={closeOnKeys(onClose)}
      >
        <div className="subhead">
          {title} {label && <span className={`chip chip-${label}`}>{label}</span>}
        </div>
        {view.error && <div className="status warn">{view.error}</div>}
        <Preview source={view.code === undefined ? undefined : { type: 'text', text: view.code, language }} focus />
        <div className="cited-result">
          <CitedResult view={view} />
        </div>
        <div className="hint">h j k l · w b · g G move · Esc / Tab / q close</div>
      </div>
    </div>,
    document.body,
  )
}

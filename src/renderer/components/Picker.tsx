import { useEffect, useRef, useState } from 'react'

import { validName } from '../../core/analyses.ts'
import { formatAge } from '../../core/age.ts'
import { fuzzyRank } from '../../core/fuzzy.ts'
import type { Analysis, OpenResult } from '../../shared/ipc.ts'

/** The fuzzy picker a window starts on. `focusToken` changes when something else (the palette) gives focus back. */
export function Picker({ focusToken, onOpened }: { focusToken: number; onOpened: () => void }) {
  const [analyses, setAnalyses] = useState<Analysis[]>()
  const [loadError, setLoadError] = useState<string>()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    window.app.analyses.list().then(setAnalyses, err => setLoadError(String(err)))
  }, [])
  useEffect(() => {
    inputRef.current?.focus()
  }, [focusToken, analyses])

  const ranked = fuzzyRank(analyses ?? [], query, a => a.name)
  const name = query.trim()
  const canCreate = analyses !== undefined && ranked.length === 0 && validName(name)
  // Shift+Enter creates the typed name even when fuzzy matches exist, unless it is already an analysis.
  const canForceCreate = analyses !== undefined && validName(name) && !analyses.some(a => a.name === name)
  const count = canCreate ? 1 : ranked.length
  const index = Math.max(0, Math.min(selected, count - 1))

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, count])

  function handle(result: OpenResult) {
    setBusy(false)
    if (!result.ok) setMessage(result.message)
    else if (result.outcome === 'focused-other-window') setMessage('Already open in another window; focused it.')
    else onOpened()
  }

  function create() {
    setBusy(true)
    window.app.analyses.create(name).then(handle, err => handle({ ok: false, message: String(err) }))
  }

  function submit() {
    if (busy) return
    setMessage(undefined)
    const target = ranked[index]
    if (target) {
      setBusy(true)
      window.app.analyses.open(target.path).then(handle, err => handle({ ok: false, message: String(err) }))
    } else if (canCreate) {
      create()
    } else if (name !== '') {
      setMessage('No match. A new name uses letters, digits, ".", "_" or "-".')
    }
  }

  return (
    <div className="picker">
      <h1>Open an analysis</h1>
      <input
        ref={inputRef}
        value={query}
        placeholder="Type to filter, or a new name to create"
        spellCheck={false}
        onChange={e => {
          setQuery(e.target.value)
          setSelected(0)
          setMessage(undefined)
        }}
        onBlur={() => {
          // Stay focused unless focus moved into a dialog (the palette).
          setTimeout(() => {
            if (!document.querySelector('[role="dialog"]')) inputRef.current?.focus()
          }, 0)
        }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return
          const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
          const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
          if (down || up) {
            e.preventDefault()
            setSelected(index + (down ? 1 : -1))
          } else if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault()
            if (!busy && canForceCreate) {
              setMessage(undefined)
              create()
            }
          } else if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            setQuery('')
          }
        }}
      />
      {loadError && <div className="status warn">Could not list analyses: {loadError}</div>}
      {analyses === undefined && !loadError && <div className="empty">Loading</div>}
      <ul ref={listRef} role="listbox" aria-label="Analyses">
        {ranked.map((a, i) => (
          <li key={a.path} role="option" aria-selected={i === index} className={i === index ? 'row sel' : 'row'}>
            <span className="grow">{a.name}</span>
            <span className="dim">{formatAge(a.modifiedMs, Date.now())}</span>
          </li>
        ))}
        {canCreate && (
          <li role="option" aria-selected className="row sel">
            <span className="grow">Create new analysis "{name}"</span>
            <span className="dim">Enter</span>
          </li>
        )}
        {analyses !== undefined && count === 0 && (
          <li className="empty">{name === '' ? 'No analyses yet. Type a name to create one.' : 'No match, and that is not a valid name.'}</li>
        )}
      </ul>
      {canForceCreate && <div className="hint">Shift+Enter creates "{name}" as a new analysis</div>}
      {message && <div className="status warn">{message}</div>}
      <div className="hint">Up/Down or Ctrl-N/Ctrl-P move  Enter opens</div>
    </div>
  )
}

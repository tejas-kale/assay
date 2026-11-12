import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

import { formatAge } from '../../core/age.ts'
import { pickerKey, pickerSubmit, pickerView } from '../../core/picker.ts'
import type { PickerView } from '../../core/picker.ts'
import type { Analysis, OpenResult } from '../../shared/ipc.ts'
import { useDoctor } from './Doctor.tsx'

type Props = Readonly<{ focusToken: number; onOpened: () => void }>
type Listing = { analyses: Analysis[]; loadedAt: number }

/** The analyses to pick from, with when they were read (the ages are shown as of then). */
function useAnalysisList() {
  const [listing, setListing] = useState<Listing>()
  const [loadError, setLoadError] = useState<string>()
  useEffect(() => {
    window.app.analyses.list().then(
      analyses => {
        setListing({ analyses, loadedAt: Date.now() })
      },
      (err: unknown) => {
        setLoadError(String(err))
      },
    )
  }, [])
  return { listing, loadError }
}

/** Opening or creating an analysis; `message` is why it did not happen. */
function useOpen(onOpened: () => void) {
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  function handle(result: OpenResult) {
    setBusy(false)
    if (!result.ok) setMessage(result.message)
    else if (result.outcome === 'focused-other-window') setMessage('Already open in another window; focused it.')
    else onOpened()
  }
  const failed = (err: unknown) => {
    handle({ ok: false, message: String(err) })
  }

  function run(start: () => Promise<OpenResult>) {
    if (busy) return
    setMessage(undefined)
    setBusy(true)
    start().then(handle, failed)
  }
  return {
    message,
    setMessage,
    open: (path: string) => { run(() => window.app.analyses.open(path)) },
    create: (title: string) => { run(() => window.app.analyses.create(title)) },
  }
}

function PickerRows(props: Readonly<{ view: PickerView<Analysis>; index: number; loadedAt: number; query: string; loaded: boolean }>) {
  const { view, index, loadedAt, query, loaded } = props
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, view.count])

  return (
    <ul ref={listRef} role="listbox" aria-label="Analyses">
      {view.ranked.map((a, i) => (
        <li key={a.path} role="option" aria-selected={i === index} className={i === index ? 'row sel' : 'row'}>
          <span className="grow">{a.title}</span>
          <span className="dim">{a.name}</span>
          <span className="dim">{formatAge(a.modifiedMs, loadedAt)}</span>
        </li>
      ))}
      {view.canCreate && (
        <li role="option" aria-selected className="row sel">
          <span className="grow">Create new analysis "{view.title}"</span>
          <span className="dim">Enter</span>
        </li>
      )}
      {loaded && view.count === 0 && (
        <li className="empty">{query.trim() === '' ? 'No analyses yet. Type a title to create one.' : 'No match, and that is not a valid title.'}</li>
      )}
    </ul>
  )
}

/** Stays focused unless focus moved into a dialog (the palette). */
function refocusUnlessDialog(input: RefObject<HTMLInputElement | null>) {
  setTimeout(() => {
    if (!document.querySelector('[role="dialog"]')) input.current?.focus()
  }, 0)
}

type KeyArgs = {
  view: PickerView<Analysis>
  index: number
  query: string
  setQuery: (query: string) => void
  setSelected: (index: number) => void
  open: (path: string) => void
  create: (title: string) => void
  setMessage: (message: string) => void
}

/** Keys in the picker: move, open the selected analysis or create the typed title, clear. */
function usePickerKeys({ view, index, query, setQuery, setSelected, open, create, setMessage }: KeyArgs) {
  return (e: KeyboardEvent) => {
    const key = pickerKey(e.key, { ctrl: e.ctrlKey, shift: e.shiftKey, composing: e.nativeEvent.isComposing })
    if (key === undefined) return
    if (key === 'clear') {
      setQuery('')
      return
    }
    e.preventDefault()
    if (key === 'next') setSelected(index + 1)
    else if (key === 'previous') setSelected(index - 1)
    else if (key === 'forceCreate') {
      if (view.canForceCreate) create(view.title)
    } else {
      const plan = pickerSubmit(view, index, query)
      if (plan.do === 'open') open(plan.path)
      else if (plan.do === 'create') create(view.title)
      else if (plan.do === 'warn') setMessage(plan.message)
    }
  }
}

/** The fuzzy picker a window starts on. `focusToken` changes when something else (the palette) gives focus back. */
export function Picker({ focusToken, onOpened }: Props) {
  const { listing, loadError } = useAnalysisList()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const { message, setMessage, open, create } = useOpen(onOpened)
  const [doctor] = useDoctor()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [focusToken, listing])

  const view = pickerView(listing?.analyses, query)
  const index = Math.max(0, Math.min(selected, view.count - 1))

  const onKeyDown = usePickerKeys({ view, index, query, setQuery, setSelected, open, create, setMessage })

  return (
    <div className="picker">
      <h1>Open an analysis</h1>
      <input
        ref={inputRef}
        value={query}
        placeholder="Type to filter, or a new title to create"
        spellCheck={false}
        onChange={e => {
          setQuery(e.target.value)
          setSelected(0)
          setMessage(undefined)
        }}
        onBlur={() => { refocusUnlessDialog(inputRef) }}
        onKeyDown={onKeyDown}
      />
      {loadError && <div className="status warn">Could not list analyses: {loadError}</div>}
      {listing === undefined && !loadError && <div className="empty">Loading</div>}
      <PickerRows view={view} index={index} loadedAt={listing?.loadedAt ?? 0} query={query} loaded={listing !== undefined} />
      {view.canForceCreate && <div className="hint">Shift+Enter creates "{view.title}" as a new analysis</div>}
      {message && <div className="status warn">{message}</div>}
      {doctor?.preparing && <div className="hint">{doctor.preparing}</div>}
      <div className="hint">Up/Down or Ctrl-N/Ctrl-P move  Enter opens</div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { INITIAL, filterItems, listNav } from '../../core/listNav.ts'
import type { ListNavState } from '../../core/listNav.ts'
import type { EditResult, Fact } from '../../shared/ipc.ts'
import { InlineInput, NAV_KEYS, SearchLine, isPaneKey } from './common.tsx'

type Mode =
  | { type: 'list' }
  | { type: 'add' }
  | { type: 'edit'; fact: Fact }
  | { type: 'confirmDelete'; fact: Fact }
  | { type: 'file'; title: string; text: string }

export function NotesTab({ facts }: { facts: Fact[] }) {
  const [nav, setNav] = useState<ListNavState>(INITIAL)
  const [mode, setMode] = useState<Mode>({ type: 'list' })
  const [message, setMessage] = useState<string>()
  const rootRef = useRef<HTMLDivElement>(null)

  const visible = filterItems(facts, nav, f => f.text)
  const selectedIndex = Math.max(0, Math.min(nav.selected, visible.length - 1))
  const selected = visible[selectedIndex]

  useEffect(() => {
    rootRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, visible.length])

  const refocus = () => requestAnimationFrame(() => rootRef.current?.focus())
  const finish = (result: EditResult) => {
    setMode({ type: 'list' })
    setMessage(result.ok ? undefined : result.message)
    refocus()
  }
  const cancel = () => {
    setMode({ type: 'list' })
    refocus()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!isPaneKey(e)) return
    if (mode.type === 'file') {
      if (e.key === 'Escape') setMode({ type: 'list' })
      else if (e.key === 'j') rootRef.current?.scrollBy(0, 40)
      else if (e.key === 'k') rootRef.current?.scrollBy(0, -40)
      else return
      e.preventDefault()
      return
    }
    if (mode.type === 'confirmDelete') {
      e.preventDefault()
      const fact = mode.fact
      setMode({ type: 'list' })
      if (e.key === 'y') void window.app.facts.delete(fact.index, fact.line).then(finish)
      return
    }
    if (mode.type !== 'list') return

    setMessage(undefined)
    if (!nav.search?.active) {
      switch (e.key) {
        case 'a':
          e.preventDefault()
          setMode({ type: 'add' })
          return
        case 'e':
          e.preventDefault()
          if (!selected) return
          if (selected.file) setMessage('A note file cannot be edited here')
          else setMode({ type: 'edit', fact: selected })
          return
        case 'd':
          e.preventDefault()
          if (selected) setMode({ type: 'confirmDelete', fact: selected })
          return
      }
    }
    const next = listNav(nav, e.key, visible.length)
    if (nav.search?.active || NAV_KEYS.has(e.key)) e.preventDefault()
    setNav(next.state)
    if (next.effect?.type === 'open' && selected?.file) {
      const { title } = selected.file
      void window.app.readNoteFile(selected.file.path).then(result => {
        if (result.ok) setMode({ type: 'file', title, text: result.text })
        else setMessage(result.message)
      })
    }
  }

  return (
    <div className="list" tabIndex={-1} ref={rootRef} data-focus-target onKeyDown={onKeyDown}>
      {mode.type === 'file' ? (
        <>
          <div className="subhead">
            {mode.title} <span className="dim">(read only, Esc to go back)</span>
          </div>
          <pre className="filetext">{mode.text}</pre>
        </>
      ) : (
        <>
          <SearchLine search={nav.search} />
          {facts.length === 0 && mode.type !== 'add' && <div className="empty">No facts yet. Press a to add one.</div>}
          <ul role="listbox" aria-label="Facts">
            {visible.map((fact, i) =>
              mode.type === 'edit' && mode.fact.index === fact.index ? (
                <li key={fact.index} className="row">
                  <InlineInput
                    label="Edit"
                    initial={fact.text}
                    onCancel={cancel}
                    onSubmit={value => void window.app.facts.edit(fact.index, mode.fact.line, value).then(finish)}
                  />
                </li>
              ) : (
                <li key={fact.index} role="option" aria-selected={i === selectedIndex} className={i === selectedIndex ? 'row sel' : 'row'}>
                  {fact.label && <span className={`chip chip-${fact.label}`}>{fact.label}</span>}
                  {fact.file && <span className="chip chip-file">note file</span>}
                  <span className="grow">{fact.text}</span>
                  {fact.query !== undefined && <span className="dim">q {fact.query}</span>}
                </li>
              ),
            )}
          </ul>
          {mode.type === 'add' && (
            <InlineInput
              label="Add fact (end with [q 12] to cite a query)"
              onCancel={cancel}
              onSubmit={value =>
                void window.app.facts.add(value).then(result => {
                  if (result.ok) setNav(s => ({ ...s, selected: Number.MAX_SAFE_INTEGER }))
                  finish(result)
                })
              }
            />
          )}
          {mode.type === 'confirmDelete' && (
            <div className="status warn">Delete "{mode.fact.text}"? y to confirm, any other key cancels</div>
          )}
          {message && <div className="status warn">{message}</div>}
          <div className="hint">j/k move  / search  Enter open file note  a add  e edit  d delete</div>
        </>
      )}
    </div>
  )
}

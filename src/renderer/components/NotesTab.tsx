import type { KeyboardEvent } from 'react'

import type { Fact } from '../../shared/ipc.ts'
import { InlineInput, SearchLine, isPaneKey, useListPane } from './common.tsx'

type Mode =
  | { type: 'list' }
  | { type: 'add' }
  | { type: 'edit'; fact: Fact }
  | { type: 'confirmDelete'; fact: Fact }
  | { type: 'file'; title: string; text: string }

export function NotesTab({ facts }: { facts: Fact[] }) {
  const { nav, setNav, mode, setMode, message, setMessage, rootRef, visible, selectedIndex, selected, finish, cancel, confirmDeleteKey, navigate } =
    useListPane<Fact, Mode>({
      items: facts,
      textOf: f => f.text,
      targetGone: m => (m.type === 'edit' || m.type === 'confirmDelete') && !facts.some(f => f.index === m.fact.index),
      confirmDelete: m => window.app.facts.delete(m.fact.index, m.fact.line),
    })

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
    if (confirmDeleteKey(e)) return
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
    const effect = navigate(e)
    if (effect?.type === 'open' && selected?.file) {
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

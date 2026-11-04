import type { KeyboardEvent, ReactNode } from 'react'

import type { ClosedThread, EditResult, Threads } from '../../shared/ipc.ts'
import { InlineInput, SearchLine, isPaneKey, useListPane, useReveal } from './common.tsx'
import type { Reveal } from './common.tsx'
import { PreviewPopup } from './Preview.tsx'
import { useState } from 'react'

/** `index` is the position in threads.open or threads.closed, which is what edits take. */
type Item = { kind: 'open'; index: number; text: string } | { kind: 'closed'; index: number; text: string; closed: ClosedThread }

type Mode =
  | { type: 'list' }
  | { type: 'add' }
  | { type: 'edit'; item: Item & { kind: 'open' } }
  | { type: 'close'; item: Item & { kind: 'open' } }
  | { type: 'confirmDelete'; item: Item }

export function ThreadsTab({ threads, reveal, onRevealed }: { threads: Threads; reveal?: Reveal | undefined; onRevealed: () => void }) {
  /** Closed threads stay folded until `z` shows them; a search hit on one unfolds them. */
  const [showClosed, setShowClosed] = useState(false)
  const revealsClosed = reveal?.target.kind === 'thread' && reveal.target.closed
  const unfolded = showClosed || revealsClosed
  const items: Item[] = [
    ...threads.open.map((text, index): Item => ({ kind: 'open', index, text })),
    ...(unfolded ? threads.closed : []).map((closed, index): Item => ({
      kind: 'closed',
      index,
      closed,
      text: closed.outcome ? `${closed.thread} ${closed.outcome}` : closed.thread,
    })),
  ]
  const { nav, setNav, mode, setMode, message, setMessage, visible, selectedIndex, selected, rootRef, finish, cancel, confirmDeleteKey, navigate } =
    useListPane<Item, Mode>({
      items,
      textOf: i => i.text,
      targetGone: m => {
        if (m.type === 'list' || m.type === 'add') return false
        const { kind, index } = m.item
        return !items.some(i => i.kind === kind && i.index === index)
      },
      confirmDelete: m => remove(m.item),
    })

  /** Tab opens the selected thread, outcome included, in a pop-up: a long one is cut in the list. */
  const [popup, setPopup] = useState<string>()

  useReveal(
    reveal,
    items,
    (item, target) => target.kind === 'thread' && target.closed === (item.kind === 'closed') && target.index === item.index,
    (index, item) => {
      if (item.kind === 'closed') setShowClosed(true)
      setMode({ type: 'list' })
      setNav({ selected: index, search: undefined })
    },
    onRevealed,
  )

  function remove(item: Item): Promise<EditResult> {
    return item.kind === 'open'
      ? window.app.threads.deleteOpen(item.index, item.text)
      : window.app.threads.deleteClosed(item.index, item.closed)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!isPaneKey(e)) return
    if (confirmDeleteKey(e)) return
    if (mode.type !== 'list') return

    setMessage(undefined)
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      if (selected) setPopup(selected.kind === 'open' ? selected.text : `${selected.closed.thread}${selected.closed.outcome ? `\n\n→ ${selected.closed.outcome}` : ''}`)
      return
    }
    if (!nav.search?.active) {
      switch (e.key) {
        case 'a':
          e.preventDefault()
          setMode({ type: 'add' })
          return
        case 'z':
          e.preventDefault()
          if (threads.closed.length === 0) return
          // Folding with a closed thread selected moves the selection to the last open one.
          if (showClosed && selected?.kind === 'closed') setNav(s => ({ ...s, selected: Math.max(0, threads.open.length - 1) }))
          setShowClosed(v => !v)
          return
        case 'e':
          e.preventDefault()
          if (selected?.kind === 'open') setMode({ type: 'edit', item: selected })
          return
        case 'c':
          e.preventDefault()
          if (selected?.kind === 'open') setMode({ type: 'close', item: selected })
          return
        case 'd':
          e.preventDefault()
          if (selected) setMode({ type: 'confirmDelete', item: selected })
          return
        case 'J':
        case 'K': {
          e.preventDefault()
          if (selected?.kind !== 'open' || nav.search) return
          const delta = e.key === 'J' ? 1 : -1
          const to = Math.max(0, Math.min(selected.index + delta, threads.open.length - 1))
          void window.app.threads.moveOpen(selected.index, selected.text, delta).then(result => {
            if (result.ok) setNav(s => ({ ...s, selected: to }))
            else setMessage(result.message)
          })
          return
        }
      }
    }
    navigate(e)
  }

  const rows: ReactNode[] = []
  let lastKind: Item['kind'] | undefined
  visible.forEach((item, i) => {
    if (item.kind !== lastKind) {
      lastKind = item.kind
      rows.push(
        <li key={`h-${item.kind}`} className="section" role="presentation">
          {item.kind === 'open' ? 'Open' : `Closed ${threads.closed.length} · z hide`}
        </li>,
      )
    }
    const key = `${item.kind}-${item.index}`
    if (mode.type === 'edit' && item.kind === 'open' && mode.item.index === item.index) {
      rows.push(
        <li key={key} className="row">
          <InlineInput
            label="Edit"
            initial={item.text}
            onCancel={cancel}
            onSubmit={value => void window.app.threads.editOpen(item.index, mode.item.text, value).then(finish)}
          />
        </li>,
      )
      return
    }
    rows.push(
      <li key={key} role="option" aria-selected={i === selectedIndex} className={i === selectedIndex ? 'row sel' : 'row'}>
        {/* The outcome goes under the thread: side by side, a long outcome squeezed the thread to one letter per line. */}
        <span className="grow">
          {item.kind === 'open' ? item.text : item.closed.thread}
          {item.kind === 'closed' && item.closed.outcome && <span className="dim outcome">→ {item.closed.outcome}</span>}
        </span>
      </li>,
    )
  })

  return (
    <div className="list" tabIndex={-1} ref={rootRef} data-focus-target onKeyDown={onKeyDown}>
      <SearchLine search={nav.search} />
      {threads.open.length + threads.closed.length === 0 && mode.type !== 'add' && <div className="empty">No threads yet. Press a to add one.</div>}
      <ul role="listbox" aria-label="Threads">
        {rows}
        {!unfolded && threads.closed.length > 0 && (
          <li key="h-closed" className="section" role="presentation">
            Closed {threads.closed.length} · z show
          </li>
        )}
      </ul>
      {mode.type === 'add' && (
        <InlineInput
          label="Add thread"
          onCancel={cancel}
          onSubmit={value => void window.app.threads.add(value).then(finish)}
        />
      )}
      {mode.type === 'close' && (
        <InlineInput
          label={`Outcome for "${mode.item.text}" (optional)`}
          allowEmpty
          onCancel={cancel}
          onSubmit={value => void window.app.threads.closeOpen(mode.item.index, mode.item.text, value).then(finish)}
        />
      )}
      {mode.type === 'confirmDelete' && (
        <div className="status warn">Delete "{mode.item.text}"? y to confirm, any other key cancels</div>
      )}
      {message && <div className="status warn">{message}</div>}
      {popup !== undefined && (
        <PreviewPopup
          source={{ type: 'text', text: popup }}
          onClose={() => {
            setPopup(undefined)
            requestAnimationFrame(() => rootRef.current?.focus())
          }}
        />
      )}
    </div>
  )
}

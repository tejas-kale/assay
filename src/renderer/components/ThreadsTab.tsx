import type { KeyboardEvent, ReactNode } from 'react'

import type { ClosedThread, EditResult, Threads } from '../../shared/ipc.ts'
import { InlineInput, SearchLine, isPaneKey, useListPane } from './common.tsx'

/** `index` is the position in threads.open or threads.closed, which is what edits take. */
type Item = { kind: 'open'; index: number; text: string } | { kind: 'closed'; index: number; text: string; closed: ClosedThread }

type Mode =
  | { type: 'list' }
  | { type: 'add' }
  | { type: 'edit'; item: Item & { kind: 'open' } }
  | { type: 'close'; item: Item & { kind: 'open' } }
  | { type: 'confirmDelete'; item: Item }

export function ThreadsTab({ threads }: { threads: Threads }) {
  const items: Item[] = [
    ...threads.open.map((text, index): Item => ({ kind: 'open', index, text })),
    ...threads.closed.map((closed, index): Item => ({
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
    if (!nav.search?.active) {
      switch (e.key) {
        case 'a':
          e.preventDefault()
          setMode({ type: 'add' })
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
          {item.kind === 'open' ? 'Open' : 'Closed'}
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
        <span className="grow">{item.kind === 'open' ? item.text : item.closed.thread}</span>
        {item.kind === 'closed' && item.closed.outcome && <span className="dim">{item.closed.outcome}</span>}
      </li>,
    )
  })

  return (
    <div className="list" tabIndex={-1} ref={rootRef} data-focus-target onKeyDown={onKeyDown}>
      <SearchLine search={nav.search} />
      {items.length === 0 && mode.type !== 'add' && <div className="empty">No threads yet. Press a to add one.</div>}
      <ul role="listbox" aria-label="Threads">
        {rows}
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
      <div className="hint">j/k move  / search  a add  e edit  c close  d delete  J/K reorder</div>
    </div>
  )
}

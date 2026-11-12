import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { movedSelection, sectionHeading, selectionAfterFold, threadCommand, threadItems, threadPopupText } from '../../core/threadsView.ts'
import type { ThreadCommand, ThreadItem } from '../../core/threadsView.ts'
import type { EditResult, Threads } from '../../shared/ipc.ts'
import { InlineInput, SearchLine, isPaneKey, useListPane, useReveal } from './common.tsx'
import type { Reveal } from './common.tsx'
import { PreviewPopup } from './Preview.tsx'

type OpenItem = ThreadItem & { kind: 'open' }

type Mode =
  | { type: 'list' }
  | { type: 'add' }
  | { type: 'edit'; item: OpenItem }
  | { type: 'close'; item: OpenItem }
  | { type: 'confirmDelete'; item: ThreadItem }

type Props = Readonly<{ threads: Threads; reveal?: Reveal; onRevealed: () => void }>
type Pane = ReturnType<typeof useListPane<ThreadItem, Mode>>

function removeThread(item: ThreadItem): Promise<EditResult> {
  return item.kind === 'open' ? window.app.threads.deleteOpen(item.index, item.text) : window.app.threads.deleteClosed(item.index, item.closed)
}

/** The list pane over `items`, with a search hit on a thread selected once it is there. */
function useThreadsPane(items: ThreadItem[], reveal: Reveal | undefined, onRevealed: () => void, unfold: () => void): Pane {
  const pane = useListPane<ThreadItem, Mode>({
    items,
    textOf: i => i.text,
    targetGone: m => {
      if (m.type === 'list' || m.type === 'add') return false
      const { kind, index } = m.item
      return !items.some(i => i.kind === kind && i.index === index)
    },
    confirmDelete: m => removeThread(m.item),
  })
  const { setMode, setNav } = pane
  useReveal(
    reveal,
    items,
    (item, target) => target.kind === 'thread' && target.closed === (item.kind === 'closed') && target.index === item.index,
    (index, item) => {
      if (item.kind === 'closed') unfold()
      setMode({ type: 'list' })
      setNav({ selected: index, search: undefined })
    },
    onRevealed,
  )
  return pane
}

function moveThread(item: OpenItem, delta: 1 | -1, pane: Pane, openCount: number) {
  void window.app.threads.moveOpen(item.index, item.text, delta).then(result => {
    if (result.ok) pane.setNav(s => ({ ...s, selected: movedSelection(item.index, delta, openCount) }))
    else pane.setMessage(result.message)
  })
}

type KeyContext = { pane: Pane; threads: Threads; showClosed: boolean; setShowClosed: (show: boolean) => void; setPopup: (text: string) => void }

/** `z`: folds or unfolds the closed threads; folding with a closed one selected moves the selection to the last open one. */
function toggleClosed(ctx: KeyContext) {
  const { pane, threads } = ctx
  if (threads.closed.length === 0) return
  const moved = ctx.showClosed ? selectionAfterFold(pane.selected, threads.open.length) : undefined
  if (moved !== undefined) pane.setNav(s => ({ ...s, selected: moved }))
  ctx.setShowClosed(!ctx.showClosed)
}

/** Carries out a list-mode command on the selected thread. */
function runCommand(command: ThreadCommand, ctx: KeyContext) {
  const { pane, threads } = ctx
  const { selected, setMode } = pane
  const open = selected?.kind === 'open' ? selected : undefined
  switch (command) {
    case 'add':
      setMode({ type: 'add' })
      break
    case 'toggleClosed':
      toggleClosed(ctx)
      break
    case 'edit':
      if (open) setMode({ type: 'edit', item: open })
      break
    case 'close':
      if (open) setMode({ type: 'close', item: open })
      break
    case 'delete':
      if (selected) setMode({ type: 'confirmDelete', item: selected })
      break
    case 'moveDown':
    case 'moveUp':
      if (open && !pane.nav.search) moveThread(open, command === 'moveDown' ? 1 : -1, pane, threads.open.length)
      break
  }
}

function useThreadKeys(ctx: KeyContext) {
  const { pane } = ctx
  return (e: KeyboardEvent) => {
    if (!isPaneKey(e) || pane.confirmDeleteKey(e) || pane.mode.type !== 'list') return
    pane.setMessage(undefined)
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      if (pane.selected) ctx.setPopup(threadPopupText(pane.selected))
      return
    }
    const command = pane.nav.search?.active ? undefined : threadCommand(e.key)
    if (command === undefined) {
      pane.navigate(e)
      return
    }
    e.preventDefault()
    runCommand(command, ctx)
  }
}

function ThreadRow(props: Readonly<{ item: ThreadItem; selected: boolean }>) {
  const { item } = props
  return (
    <li role="option" aria-selected={props.selected} className={props.selected ? 'row sel' : 'row'}>
      {/* The outcome goes under the thread: side by side, a long outcome squeezed the thread to one letter per line. */}
      <span className="grow">
        {item.kind === 'open' ? item.text : item.closed.thread}
        {item.kind === 'closed' && item.closed.outcome && <span className="dim outcome">→ {item.closed.outcome}</span>}
      </span>
    </li>
  )
}

function threadRows(pane: Pane, closedCount: number): ReactNode[] {
  const { visible, selectedIndex, mode } = pane
  const rows: ReactNode[] = []
  let lastKind: ThreadItem['kind'] | undefined
  visible.forEach((item, i) => {
    if (item.kind !== lastKind) {
      lastKind = item.kind
      rows.push(
        <li key={`h-${item.kind}`} className="section" role="presentation">
          {sectionHeading(item.kind, closedCount)}
        </li>,
      )
    }
    const key = `${item.kind}-${String(item.index)}`
    if (mode.type === 'edit' && item.kind === 'open' && mode.item.index === item.index) {
      rows.push(
        <li key={key} className="row">
          <InlineInput
            label="Edit"
            initial={item.text}
            onCancel={pane.cancel}
            onSubmit={value => void window.app.threads.editOpen(item.index, mode.item.text, value).then(pane.finish)}
          />
        </li>,
      )
      return
    }
    rows.push(<ThreadRow key={key} item={item} selected={i === selectedIndex} />)
  })
  return rows
}

function ThreadPrompts({ pane }: Readonly<{ pane: Pane }>) {
  const { mode, finish, cancel } = pane
  if (mode.type === 'add') return <InlineInput label="Add thread" onCancel={cancel} onSubmit={value => void window.app.threads.add(value).then(finish)} />
  if (mode.type === 'close') {
    const { item } = mode
    return (
      <InlineInput
        label={`Outcome for "${item.text}" (optional)`}
        allowEmpty
        onCancel={cancel}
        onSubmit={value => void window.app.threads.closeOpen(item.index, item.text, value).then(finish)}
      />
    )
  }
  if (mode.type === 'confirmDelete') return <div className="status warn">Delete "{mode.item.text}"? y to confirm, any other key cancels</div>
  return null
}

export function ThreadsTab({ threads, reveal, onRevealed }: Props) {
  /** Closed threads stay folded until `z` shows them; a search hit on one unfolds them. */
  const [showClosed, setShowClosed] = useState(false)
  /** Tab opens the selected thread, outcome included, in a pop-up: a long one is cut in the list. */
  const [popup, setPopup] = useState<string>()
  const revealsClosed = reveal?.target.kind === 'thread' && reveal.target.closed
  const unfolded = showClosed || revealsClosed
  const pane = useThreadsPane(threadItems(threads, unfolded), reveal, onRevealed, () => { setShowClosed(true) })
  const onKeyDown = useThreadKeys({ pane, threads, showClosed, setShowClosed, setPopup })
  const { rootRef, nav, mode, message } = pane

  return (
    <div className="list" tabIndex={-1} ref={rootRef} data-focus-target onKeyDown={onKeyDown}>
      <SearchLine search={nav.search} />
      {threads.open.length + threads.closed.length === 0 && mode.type !== 'add' && <div className="empty">No threads yet. Press a to add one.</div>}
      <ul role="listbox" aria-label="Threads">
        {threadRows(pane, threads.closed.length)}
        {!unfolded && threads.closed.length > 0 && (
          <li key="h-closed" className="section" role="presentation">
            Closed {threads.closed.length} · z show
          </li>
        )}
      </ul>
      <ThreadPrompts pane={pane} />
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

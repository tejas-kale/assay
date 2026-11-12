import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react'

import { INITIAL, filterItems, listNav } from '../../core/listNav.ts'
import type { ListNavEffect, ListNavState } from '../../core/listNav.ts'
import type { SearchTarget } from '../../core/search.ts'
import type { EditResult } from '../../shared/ipc.ts'

export type PaneName = 'terminal' | 'notes' | 'data'

/** A universal-search hit for a tab to select. `n` makes a repeat of the same hit a new request. */
export type Reveal = { target: SearchTarget; n: number }

/**
 * Carries out a reveal once `items` are there: finds the item `matches` picks and hands it to `apply`
 * (which selects it), then calls `onDone` so a later remount of the tab does not select it again.
 */
export function useReveal<T>(
  reveal: Reveal | undefined,
  items: readonly T[] | undefined,
  handlers: Readonly<{
    matches: (item: T, target: SearchTarget) => boolean
    apply: (index: number, item: T) => void
    onDone: () => void
  }>,
) {
  const { matches, apply, onDone } = handlers
  const carryOut = useEffectEvent(() => {
    if (!reveal || !items) return
    const index = items.findIndex(item => matches(item, reveal.target))
    const item = items[index]
    if (item !== undefined) apply(index, item)
    onDone()
  })
  const requestNumber = reveal?.n
  const ready = items !== undefined
  useEffect(() => {
    carryOut()
  }, [requestNumber, ready])
}

/** True for inputs, textareas, selects, editable elements and anything inside a dialog: pane keys must not run there. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.closest('input, textarea, select, [role="dialog"]') !== null
}

/** Keys listNav acts on; other keys (Tab, ...) keep their default. */
export const NAV_KEYS: ReadonlySet<string> = new Set(['j', 'k', 'g', 'G', '/', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown'])

/** A key event a list pane should look at: not from a typing target, no Cmd, Ctrl or Alt. */
export function isPaneKey(e: KeyboardEvent): boolean {
  return !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey
}

/** One-line input: Enter saves a non-empty value, Escape cancels. */
export function InlineInput(
  props: Readonly<{
    label: string
    initial?: string
    /** Enter saves an empty value too. */
    allowEmpty?: boolean
    onSubmit: (value: string) => void
    onCancel: () => void
  }>,
) {
  const [value, setValue] = useState(props.initial ?? '')
  return (
    <div className="inline-input">
      <label>
        <span className="dim">{props.label}</span>
        <input
          autoFocus
          value={value}
          spellCheck={false}
          onChange={e => {
            setValue(e.target.value)
          }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              e.preventDefault()
              if (props.allowEmpty || value.trim() !== '') props.onSubmit(value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              props.onCancel()
            }
          }}
        />
      </label>
    </div>
  )
}

/** The `/query` line shown while a search is active or kept. */
export function SearchLine(props: Readonly<{ search: { active: boolean; query: string } | undefined }>) {
  if (!props.search) return null
  return (
    <div className="searchline">
      /{props.search.query}
      {props.search.active ? '█' : ''}
    </div>
  )
}

export type ListMode = { type: 'list' }
const LIST: ListMode = { type: 'list' }

type ListPaneOptions<T, M extends { type: string }> = {
  items: readonly T[]
  textOf: (item: T) => string
  /** True when the item a non-list mode points at is gone (a poll removed it): the pane then returns to the list. */
  targetGone: (mode: M | ListMode) => boolean
  /** Deletes the item of a confirmed `confirmDelete` mode. */
  confirmDelete: (mode: Extract<M, { type: 'confirmDelete' }>) => Promise<EditResult>
}

export type ListPane<T, M extends { type: string }> = {
  nav: ListNavState
  setNav: Dispatch<SetStateAction<ListNavState>>
  mode: M | ListMode
  setMode: Dispatch<SetStateAction<M | ListMode>>
  message: string | undefined
  setMessage: Dispatch<SetStateAction<string | undefined>>
  rootRef: RefObject<HTMLDivElement | null>
  visible: T[]
  selectedIndex: number
  selected: T | undefined
  finish: (result: EditResult) => void
  cancel: () => void
  /** Handles a key in `confirmDelete` mode. Returns true when the key was consumed. */
  confirmDeleteKey: (e: KeyboardEvent) => boolean
  /** The shared tail of the list-mode key handler: moves the selection and returns listNav's effect. */
  navigate: (e: KeyboardEvent) => ListNavEffect | undefined
}

/** The pane's mode, back at the list as soon as the item it points at is gone. */
function useMode<M extends { type: string }>(targetGone: (mode: M | ListMode) => boolean) {
  const [mode, setMode] = useState<M | ListMode>(LIST)
  // Set during render, not in an effect: React renders again at once, so the gone item is never drawn.
  if (mode.type !== 'list' && targetGone(mode)) setMode(LIST)
  return [mode, setMode] as const
}

/** How a mode ends: back to the list, with the root focused again and the edit's failure, if any, as the message. */
function useModeEnd<M extends { type: string }>(
  setMode: Dispatch<SetStateAction<M | ListMode>>,
  setMessage: Dispatch<SetStateAction<string | undefined>>,
  rootRef: RefObject<HTMLDivElement | null>,
) {
  const refocus = () => requestAnimationFrame(() => rootRef.current?.focus())
  const finish = (result: EditResult) => {
    setMode(LIST)
    setMessage(result.ok ? undefined : result.message)
    refocus()
  }
  const cancel = () => {
    setMode(LIST)
    refocus()
  }
  return { finish, cancel }
}

/**
 * State and key handling shared by the list tabs. `M` is the tab's mode union; `list` and
 * `confirmDelete` are the two modes this hook knows about.
 */
export function useListPane<T, M extends { type: string }>(opts: ListPaneOptions<T, M>): ListPane<T, M> {
  const [nav, setNav] = useState<ListNavState>(INITIAL)
  const [mode, setMode] = useMode<M>(opts.targetGone)
  const [message, setMessage] = useState<string>()
  const rootRef = useRef<HTMLDivElement>(null)

  const visible = filterItems(opts.items, nav, opts.textOf)
  const selectedIndex = Math.max(0, Math.min(nav.selected, visible.length - 1))
  const selected = visible[selectedIndex]
  useEffect(() => {
    rootRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, visible.length])

  const { finish, cancel } = useModeEnd(setMode, setMessage, rootRef)
  const confirmDeleteKey = (e: KeyboardEvent) => {
    if (mode.type !== 'confirmDelete') return false
    e.preventDefault()
    const target = mode as unknown as Extract<M, { type: 'confirmDelete' }>
    setMode(LIST)
    if (e.key === 'y') void opts.confirmDelete(target).then(finish)
    return true
  }
  const navigate = (e: KeyboardEvent) => {
    const next = listNav(nav, e.key, visible.length)
    if (nav.search?.active || NAV_KEYS.has(e.key)) e.preventDefault()
    setNav(next.state)
    return next.effect
  }
  return { nav, setNav, mode, setMode, message, setMessage, rootRef, visible, selectedIndex, selected, finish, cancel, confirmDeleteKey, navigate }
}

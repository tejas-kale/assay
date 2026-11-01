import { useState } from 'react'
import type { KeyboardEvent } from 'react'

export type PaneName = 'terminal' | 'notes' | 'data'
export type NotesTabName = 'notes' | 'threads'
export type DataTabName = 'data' | 'plots' | 'code' | 'history'

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
export function InlineInput(props: {
  label: string
  initial?: string
  /** Enter saves an empty value too. */
  allowEmpty?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(props.initial ?? '')
  return (
    <div className="inline-input">
      <label>
        <span className="dim">{props.label}</span>
        <input
          autoFocus
          value={value}
          spellCheck={false}
          onChange={e => setValue(e.target.value)}
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
export function SearchLine(props: { search: { active: boolean; query: string } | undefined }) {
  if (!props.search) return null
  return (
    <div className="searchline">
      /{props.search.query}
      {props.search.active ? '█' : ''}
    </div>
  )
}

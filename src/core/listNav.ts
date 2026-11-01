import { fuzzyRank } from './fuzzy.ts'

export type ListNavState = {
  selected: number
  /** `active` while the user is typing the query; kept (inactive) after Enter. */
  search: { active: boolean; query: string } | undefined
}
export type ListNavEffect = { type: 'open' }

export const INITIAL: ListNavState = { selected: 0, search: undefined }

const clamp = (selected: number, count: number) => Math.max(0, Math.min(selected, count - 1))

/**
 * One key in a list pane. `count` is the number of items currently shown (after the filter).
 * Keys are `KeyboardEvent.key` values; the caller drops events with Cmd or Ctrl held.
 */
export function listNav(state: ListNavState, key: string, count: number): { state: ListNavState; effect?: ListNavEffect } {
  const selected = clamp(state.selected, count)
  const at = (to: number): { state: ListNavState } => ({ state: { ...state, selected: clamp(to, count) } })
  const search = state.search

  if (search?.active) {
    if (key === 'Escape') return { state: { selected: 0, search: undefined } }
    if (key === 'Enter') return { state: { selected, search: { active: false, query: search.query } } }
    if (key === 'Backspace') return { state: { selected: 0, search: { active: true, query: search.query.slice(0, -1) } } }
    if (key.length === 1) return { state: { selected: 0, search: { active: true, query: search.query + key } } }
    return { state: { ...state, selected } }
  }

  switch (key) {
    case 'j':
    case 'ArrowDown':
      return at(selected + 1)
    case 'k':
    case 'ArrowUp':
      return at(selected - 1)
    case 'g':
      return at(0)
    case 'G':
      return at(count - 1)
    case '/':
      return { state: { selected: 0, search: { active: true, query: search?.query ?? '' } } }
    case 'Enter':
      return count > 0 ? { state: { ...state, selected }, effect: { type: 'open' } } : { state: { ...state, selected } }
    case 'Escape':
      return { state: { selected, search: undefined } }
    default:
      return { state: { ...state, selected } }
  }
}

/** The items to show for a state: fuzzy-filtered while a search has text. */
export function filterItems<T>(items: readonly T[], state: ListNavState, keyOf: (item: T) => string): T[] {
  return fuzzyRank(items, state.search?.query ?? '', keyOf)
}

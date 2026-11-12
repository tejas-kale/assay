// What the analysis picker shows and does for a typed query and a key; the component only draws and sends.
import { cleanTitle } from './analyses.ts'
import { fuzzyRank } from './fuzzy.ts'

type Listed = { path: string; title: string; name: string }

export type PickerView<T extends Listed> = {
  /** The analyses matching the query, best first. */
  ranked: T[]
  /** The query as a new analysis's title; empty when the query is not a valid title. */
  title: string
  /** Enter creates `title`: nothing matches and it is a valid title. */
  canCreate: boolean
  /** Shift+Enter creates `title` even when others match, unless an analysis already has that title. */
  canForceCreate: boolean
  /** Rows to pick from: the matches, or the one "create" row. */
  count: number
  /** Why a typed query is no title; undefined when it is one. */
  invalid: string | undefined
}

/** `analyses` is undefined while the list loads. */
export function pickerView<T extends Listed>(analyses: readonly T[] | undefined, query: string): PickerView<T> {
  const ranked = fuzzyRank(analyses ?? [], query, a => `${a.title} ${a.name}`)
  const cleaned = cleanTitle(query)
  const title = cleaned.ok ? cleaned.title : ''
  const loaded = analyses !== undefined
  const canCreate = loaded && ranked.length === 0 && cleaned.ok
  const canForceCreate = loaded && cleaned.ok && !analyses.some(a => a.title === title)
  return { ranked, title, canCreate, canForceCreate, count: canCreate ? 1 : ranked.length, invalid: cleaned.ok ? undefined : cleaned.message }
}

export type PickerSubmit = { do: 'open'; path: string } | { do: 'create' } | { do: 'warn'; message: string } | { do: 'nothing' }

/** Enter on row `index`: open it, create the typed title, or say why the query is no title. */
export function pickerSubmit<T extends Listed>(view: PickerView<T>, index: number, query: string): PickerSubmit {
  const target = view.ranked[index]
  if (target) return { do: 'open', path: target.path }
  if (view.canCreate) return { do: 'create' }
  if (view.invalid !== undefined && query.trim() !== '') return { do: 'warn', message: `No match. ${view.invalid}` }
  return { do: 'nothing' }
}

export type PickerKey = 'next' | 'previous' | 'submit' | 'forceCreate' | 'clear'

export function pickerKey(key: string, mods: { ctrl: boolean; shift: boolean; composing: boolean }): PickerKey | undefined {
  if (mods.composing) return undefined
  if (key === 'ArrowDown' || (mods.ctrl && key === 'n')) return 'next'
  if (key === 'ArrowUp' || (mods.ctrl && key === 'p')) return 'previous'
  if (key === 'Enter') return mods.shift ? 'forceCreate' : 'submit'
  if (key === 'Escape') return 'clear'
  return undefined
}

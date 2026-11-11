// The tab registry: one entry per tab, read by the panes, the keymap, the palette and Settings (docs/slice-11.md, 11e).
// Adding a tab: docs/process/adding-a-tab.md.

export type Pane = 'notes' | 'data'

/** A snapshot of the current run (file names) and of how many runs exist. `trust` keys the latest trust review. */
export type Seen = { number?: number; code?: string; data?: string; plots: readonly string[]; failed: boolean; runCount: number; trust?: string }

export type TabSpec = {
  id: string
  title: string
  pane: Pane
  /** The key code of its Ctrl+Shift shortcut. */
  shortcut: string
  /** True when the change from `before` to `after` is new content in this tab. A tab without one is never marked. */
  marker?: (before: Seen, after: Seen) => boolean
}

/** Every tab, each pane's in its default order. */
export const TABS = [
  { id: 'overview', title: 'Overview', pane: 'notes', shortcut: 'KeyO' },
  { id: 'threads', title: 'Threads', pane: 'notes', shortcut: 'KeyT' },
  { id: 'notes', title: 'Notes', pane: 'notes', shortcut: 'KeyN' },
  { id: 'files', title: 'Files', pane: 'notes', shortcut: 'KeyF' },
  { id: 'data', title: 'Data', pane: 'data', shortcut: 'KeyD', marker: (b, a) => b.data !== a.data || b.failed !== a.failed },
  { id: 'plots', title: 'Plots', pane: 'data', shortcut: 'KeyP', marker: (b, a) => b.plots.join('\n') !== a.plots.join('\n') },
  { id: 'code', title: 'Code', pane: 'data', shortcut: 'KeyC', marker: (b, a) => b.number !== a.number || b.code !== a.code },
  { id: 'history', title: 'History', pane: 'data', shortcut: 'KeyH', marker: (b, a) => a.runCount > b.runCount },
  // Steps draws the current run, which Data and Code already mark.
  { id: 'steps', title: 'Steps', pane: 'data', shortcut: 'KeyS' },
  { id: 'trust', title: 'Trust', pane: 'data', shortcut: 'KeyR', marker: (b, a) => b.trust !== a.trust },
] as const satisfies readonly TabSpec[]

export type TabId = (typeof TABS)[number]['id']
/** The pane tab `K` lives in. */
export type PaneOf<K extends TabId> = Extract<(typeof TABS)[number], { id: K }>['pane']
/** The tabs of pane `P`. */
export type TabIdIn<P extends Pane> = Extract<(typeof TABS)[number], { pane: P }>['id']

const SPECS: readonly TabSpec[] = TABS

export const tabSpec = (id: TabId): TabSpec => SPECS.find(t => t.id === id) as TabSpec

export const isTabId = (value: unknown): value is TabId => SPECS.some(t => t.id === value)

/** A pane's tabs in their default order. */
export const tabsOf = (pane: Pane): TabId[] => TABS.filter(t => t.pane === pane).map(t => t.id)

/** `active` is the tab on screen: it is never marked, and showing a tab clears its marker. */
export function markTabs(markers: ReadonlySet<string>, before: Seen, after: Seen, active: TabId): Set<string> {
  const next = new Set(markers)
  for (const tab of SPECS) if (tab.marker?.(before, after)) next.add(tab.id)
  next.delete(active)
  return next
}

// --- the user's choices (settings.json's `tabs`) ---

export type TabPref = { id: TabId; on: boolean }
/** Each pane's tabs in the user's order, each on or off. Applies to the whole app. */
export type TabPrefs = Record<Pane, TabPref[]>

export const defaultTabPrefs = (): TabPrefs => ({
  notes: tabsOf('notes').map(id => ({ id, on: true })),
  data: tabsOf('data').map(id => ({ id, on: true })),
})

/** One pane's saved list: unknown ids, the other pane's ids and repeats dropped, a tab it lacks appended and on. */
function parsePane(raw: unknown, pane: Pane): TabPref[] {
  const saved: TabPref[] = []
  for (const item of Array.isArray(raw) ? (raw as unknown[]) : []) {
    const id: unknown = item !== null && typeof item === 'object' ? Reflect.get(item, 'id') : undefined
    if (!isTabId(id) || tabSpec(id).pane !== pane || saved.some(t => t.id === id)) continue
    saved.push({ id, on: Reflect.get(item as object, 'on') !== false })
  }
  const missing = tabsOf(pane).filter(id => !saved.some(t => t.id === id))
  return [...saved, ...missing.map(id => ({ id, on: true }))]
}

/** settings.json's `tabs`, with the defaults filled in. A tab added in a later version appears at the end, on. */
export function parseTabPrefs(raw: unknown): TabPrefs {
  const object = raw !== null && typeof raw === 'object' ? raw : {}
  return { notes: parsePane(Reflect.get(object, 'notes'), 'notes'), data: parsePane(Reflect.get(object, 'data'), 'data') }
}

const paneOf = (id: TabId): Pane => tabSpec(id).pane

export const isTabOn = (prefs: TabPrefs, id: TabId): boolean => prefs[paneOf(id)].find(t => t.id === id)?.on !== false

/** The tabs a pane's tab bar shows, in order. */
export const visibleTabs = (prefs: TabPrefs, pane: Pane): TabId[] => prefs[pane].filter(t => t.on).map(t => t.id)

export const isPaneHidden = (prefs: TabPrefs, pane: Pane): boolean => visibleTabs(prefs, pane).length === 0

/** The tab after `current` that is on, wrapping; undefined when the pane has none on. */
export function nextTab(prefs: TabPrefs, pane: Pane, current: TabId): TabId | undefined {
  const order = prefs[pane]
  const at = order.findIndex(t => t.id === current)
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(at + step) % order.length]
    if (candidate?.on) return candidate.id
  }
  return undefined
}

/** What a pane shows when `chosen` is its tab: `chosen` while it is on, else its first tab that is on. */
export const shownTab = (prefs: TabPrefs, pane: Pane, chosen: TabId): TabId | undefined =>
  isTabOn(prefs, chosen) ? chosen : visibleTabs(prefs, pane)[0]

const withPane = (prefs: TabPrefs, pane: Pane, list: TabPref[]): TabPrefs => ({ ...prefs, [pane]: list })

/** `id` one place earlier (-1) or later (1) in its pane; unchanged at either end. */
export function moveTab(prefs: TabPrefs, id: TabId, delta: 1 | -1): TabPrefs {
  const pane = paneOf(id)
  const list = [...prefs[pane]]
  const at = list.findIndex(t => t.id === id)
  const to = at + delta
  const [moving, other] = [list[at], list[to]]
  if (!moving || !other) return prefs
  list[at] = other
  list[to] = moving
  return withPane(prefs, pane, list)
}

export const setTabOn = (prefs: TabPrefs, id: TabId, on: boolean): TabPrefs =>
  withPane(prefs, paneOf(id), prefs[paneOf(id)].map(t => (t.id === id ? { ...t, on } : t)))

const SETTINGS_HINT = 'Settings (⌘,)'
const PANE_TITLE: Record<Pane, string> = { notes: 'Notes', data: 'Data' }

/** The toast for a shortcut, palette command or reveal aimed at a tab that is off. */
export const tabOffText = (id: TabId): string => `${tabSpec(id).title} tab is off: ${SETTINGS_HINT}`

/** The toast for Ctrl+2 or Ctrl+3 aimed at a hidden pane. */
export const paneOffText = (pane: Pane): string => `Every ${PANE_TITLE[pane]} pane tab is off: ${SETTINGS_HINT}`

/** The tab that shows a universal-search hit of this kind. */
export function hitTab(kind: 'thread' | 'note' | 'file' | 'run'): TabId {
  if (kind === 'thread') return 'threads'
  if (kind === 'note') return 'notes'
  if (kind === 'file') return 'files'
  return 'data'
}

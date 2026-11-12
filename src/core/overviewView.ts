// What the Overview tab shows and what its keys do; the component only draws and sends.
import type { OverviewDoc, OverviewState, OverviewWhich } from './overview.ts'
import type { Segment } from './rootNotes.ts'

const pad = (n: number) => String(n).padStart(3, '0')

/** A segment as plain text: links by their label (or `[[id]]`), citations as `[analysis q 007]`. */
export function segmentText(s: Segment): string {
  if (s.type === 'text') return s.text
  if (s.type === 'link') return s.label ?? `[[${s.id}]]`
  return `[${s.analysis} q ${pad(s.number)}]`
}

/** What the tab shows for `which`: the document, or why there is none. */
export function overviewShown(state: OverviewState, which: OverviewWhich, slug: string): { doc?: OverviewDoc; missing?: string } {
  const noOverview = { missing: `No overview yet: analyses/${slug}/overview.md` }
  if (which === 'analysis') return state.analysis ? { doc: state.analysis } : noOverview
  if (!state.analysis) return noOverview
  if (!state.system) return { missing: 'No system named: add "System: systems/<name>.md" to overview.md' }
  return state.systemDoc ? { doc: state.systemDoc } : { missing: `No file ${state.system}` }
}

/** The line above the document: "Analysis", or the system's name without its folder and extension. */
export function overviewHeading(which: OverviewWhich, system: string | undefined): string {
  if (which === 'analysis') return 'Analysis'
  return `System: ${system?.replace(/^systems\/|\.md$/g, '') ?? '—'}`
}

export type OverviewKey = 'toggleWhich' | 'toggleDiff' | 'markRead' | 'down' | 'up' | 'top' | 'bottom'

const OVERVIEW_KEYS: Record<string, OverviewKey> = { s: 'toggleWhich', d: 'toggleDiff', m: 'markRead', j: 'down', k: 'up', g: 'top', G: 'bottom' }

export function overviewKey(key: string): OverviewKey | undefined {
  return Object.hasOwn(OVERVIEW_KEYS, key) ? OVERVIEW_KEYS[key] : undefined
}

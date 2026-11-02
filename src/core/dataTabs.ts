// Which of the Data pane's tabs have content the user has not looked at.

export type MarkedTab = 'data' | 'plots' | 'code' | 'history' | 'trust'

/** A snapshot of the current run (file names) and of how many runs exist. `trust` keys the latest trust review. */
export type Seen = { number?: number; code?: string; data?: string; plots: readonly string[]; failed: boolean; runCount: number; trust?: string }

/** `active` is the tab on screen: it is never marked, and showing a tab clears its marker. */
export function markTabs(markers: ReadonlySet<string>, before: Seen, after: Seen, active: MarkedTab): Set<string> {
  const next = new Set(markers)
  if (before.data !== after.data || before.failed !== after.failed) next.add('data')
  if (before.number !== after.number || before.code !== after.code) next.add('code')
  if (before.plots.join('\n') !== after.plots.join('\n')) next.add('plots')
  if (after.runCount > before.runCount) next.add('history')
  if (before.trust !== after.trust) next.add('trust')
  next.delete(active)
  return next
}

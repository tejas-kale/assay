// Which of the Data pane's tabs have content the user has not looked at.

export type MarkedTab = 'data' | 'code' | 'history'

/** A snapshot of the current run (file names) and of how many runs exist. */
export type Seen = { number?: number; code?: string; data?: string; failed: boolean; runCount: number }

/** `active` is the tab on screen: it is never marked, and showing a tab clears its marker. */
export function markTabs(markers: ReadonlySet<MarkedTab>, before: Seen, after: Seen, active: string): Set<MarkedTab> {
  const next = new Set(markers)
  if (before.data !== after.data || before.failed !== after.failed) next.add('data')
  if (before.number !== after.number || before.code !== after.code) next.add('code')
  if (after.runCount > before.runCount) next.add('history')
  next.delete(active as MarkedTab)
  return next
}

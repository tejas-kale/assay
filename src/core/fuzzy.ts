const isWordStart = (key: string, i: number) => i === 0 || !/[a-z0-9]/i.test(key[i - 1] ?? '')

type Row = (number | undefined)[]

/** The score of matching `key[i]` (a position where the query's next character occurs); undefined when the previous character has no placement leading to it. */
function matchScore(key: string, i: number, apart: number, prev: Row | undefined): number | undefined {
  const gain = 1 + (isWordStart(key, i) ? 6 : 0)
  if (!prev) return gain
  const base = Math.max(apart, (prev[i - 1] ?? -Infinity) + 4)
  return base === -Infinity ? undefined : base + gain
}

/** For one query character: at each key position, the best score with that character matched there. `prev` is the row of the query character before it. */
function nextRow(key: string, lower: string, wanted: string, prev: Row | undefined): Row {
  const row: Row = []
  // Best of prev over positions at least two before i (a gap, so no run bonus).
  let apart = -Infinity
  for (let i = 0; i < lower.length; i++) {
    if (i >= 2) apart = Math.max(apart, prev?.[i - 2] ?? -Infinity)
    row.push(lower[i] === wanted ? matchScore(key, i, apart, prev) : undefined)
  }
  return row
}

/** Best score of `query` as a subsequence of `key`, or undefined when it is not one. */
function score(key: string, query: string): number | undefined {
  const lower = key.toLowerCase()
  let row: Row | undefined
  for (let j = 0; j < query.length; j++) row = nextRow(key, lower, query[j] ?? '', row)
  const scores = (row ?? []).filter((each): each is number => each !== undefined)
  return scores.length === 0 ? undefined : Math.max(...scores)
}

/**
 * Items whose key contains the query's characters in order, case-insensitively, best first.
 * Consecutive runs and word starts score higher; ties keep input order.
 */
export function fuzzyRank<T>(items: readonly T[], query: string, keyOf: (item: T) => string): T[] {
  const wanted = query.trim().toLowerCase().replace(/\s+/g, '')
  if (wanted === '') return [...items]
  return items
    .flatMap((item, order) => {
      const found = score(keyOf(item), wanted)
      return found === undefined ? [] : [{ item, found, order }]
    })
    .sort((a, b) => b.found - a.found || a.order - b.order)
    .map(each => each.item)
}

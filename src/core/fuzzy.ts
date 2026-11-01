const isWordStart = (key: string, i: number) => i === 0 || !/[a-z0-9]/i.test(key[i - 1] ?? '')

/** Best score of `query` as a subsequence of `key`, or undefined when it is not one. */
function score(key: string, query: string): number | undefined {
  const lower = key.toLowerCase()
  // prev[i]: best score with the previous query char matched at key position i.
  let prev: (number | undefined)[] = []
  for (let j = 0; j < query.length; j++) {
    const row: (number | undefined)[] = []
    // Best of prev over positions at least two before i (a gap, so no run bonus).
    let apart = -Infinity
    for (let i = 0; i < lower.length; i++) {
      if (i >= 2) apart = Math.max(apart, prev[i - 2] ?? -Infinity)
      if (lower[i] !== query[j]) {
        row.push(undefined)
        continue
      }
      const gain = 1 + (isWordStart(key, i) ? 6 : 0)
      if (j === 0) row.push(gain)
      else {
        const base = Math.max(apart, (prev[i - 1] ?? -Infinity) + 4)
        row.push(base === -Infinity ? undefined : base + gain)
      }
    }
    prev = row
  }
  const scores = prev.filter((s): s is number => s !== undefined)
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

// The order `Array.prototype.sort()` gives strings (by UTF-16 code unit), as a comparator the linter accepts. The
// migrations sort names this way so a rerun, and the reports, keep the order they always had.

/** Orders strings by UTF-16 code unit; not `localeCompare`, which differs for capitals and accents. */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  return Number(a > b)
}

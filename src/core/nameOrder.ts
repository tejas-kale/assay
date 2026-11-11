// Orders and picks file names the way main reads folders: by UTF-16 code unit, which is how `Array.sort()` orders
// strings and what the note IDs and the reply and run numbers rely on (`localeCompare` would order them differently).

/** The comparator for `toSorted`: code units, not locale rules. */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** The finished `.json` files of a folder listing: a name starting with `.` is a half-written temp file. */
export function jsonFileNames(names: readonly string[]): string[] {
  return names.filter(name => name.endsWith('.json') && !name.startsWith('.'))
}

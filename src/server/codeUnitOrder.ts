/** Orders strings by UTF-16 code unit, as an argument-less `sort()` does (`localeCompare` orders them differently). */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

// The analyses one window holds. Each is numbered by its place in `paths` (Cmd+1 is the first); `current` is the
// one shown. Closing one renumbers the rest. Pure: main keeps the set and decides which view to show from it.

export const MAX_ANALYSES = 9

export type AnalysisSet = { readonly paths: readonly string[]; readonly current: string | undefined }

export const EMPTY_SET: AnalysisSet = { paths: [], current: undefined }

export type OpenSetResult = { ok: true; set: AnalysisSet } | { ok: false; reason: 'full' }

/** Adds `path` and shows it; one already in the set is only shown. A tenth is refused so every one has a shortcut. */
export function openAnalysisIn(set: AnalysisSet, path: string): OpenSetResult {
  if (set.paths.includes(path)) return { ok: true, set: { ...set, current: path } }
  if (set.paths.length >= MAX_ANALYSES) return { ok: false, reason: 'full' }
  return { ok: true, set: { paths: [...set.paths, path], current: path } }
}

/** Shows analysis number `n` (from 1); the same set when there is none. */
export function switchTo(set: AnalysisSet, n: number): AnalysisSet {
  const path = set.paths[n - 1]
  return path === undefined ? set : { ...set, current: path }
}

/**
 * Drops `path`. When it was the shown one, shows the one that takes its number, or the one before when it was last;
 * otherwise the shown one stays. The same set when `path` is not in it.
 */
export function closeAnalysis(set: AnalysisSet, path: string): AnalysisSet {
  const index = set.paths.indexOf(path)
  if (index < 0) return set
  const paths = set.paths.filter((_, i) => i !== index)
  if (paths.length === 0) return EMPTY_SET
  return { paths, current: path === set.current ? paths[Math.min(index, paths.length - 1)] : set.current }
}

/** Drops the shown analysis (see closeAnalysis). */
export const closeCurrent = (set: AnalysisSet): AnalysisSet => (set.current === undefined ? set : closeAnalysis(set, set.current))

/** A set saved at quit, made valid again: no duplicates, at most nine, and a current that is in it. */
export function restoreSet(saved: { paths: readonly string[]; current: string | undefined }): AnalysisSet {
  const paths = [...new Set(saved.paths)].slice(0, MAX_ANALYSES)
  if (paths.length === 0) return EMPTY_SET
  const current = saved.current !== undefined && paths.includes(saved.current) ? saved.current : paths[0]
  return { paths, current }
}

// The open analyses saved at quit (`open-analyses.json` in the user data folder), read back at the next launch.
import { EMPTY_SET, restoreSet } from './analysisSet.ts'
import type { AnalysisSet } from './analysisSet.ts'

const field = (object: unknown, key: string): unknown => (object !== null && typeof object === 'object' ? Reflect.get(object, key) : undefined)

/** The set the file holds, made valid again; the empty set when the text is not JSON or holds no paths. */
export function parseSavedSet(text: string): AnalysisSet {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return EMPTY_SET
  }
  const paths = field(parsed, 'paths')
  if (!Array.isArray(paths)) return EMPTY_SET
  const current = field(parsed, 'current')
  return restoreSet({ paths: paths.filter((p): p is string => typeof p === 'string'), current: typeof current === 'string' ? current : undefined })
}

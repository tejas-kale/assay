// A citation's provenance label, derived from the cited analysis's run files each time a note is read. Nothing is
// stored. Same rules as the old fact labels: trusted (a trusted calculation's run, with its result), queried (any
// other SQL run with a result), computed (a Python run that ended ok), unverified; plus stale (a trusted run whose
// calculation has a newer commit) and missing (no such analysis or run).
import type { FsPort } from './analyses.ts'
import { stripTrailingSlashes } from './slugText.ts'
import { parseTrustedHeader } from './calculations.ts'
import { parseRunResult, parseRuns } from './runs.ts'
import type { Citation } from './rootNotes.ts'

export type CitationLabel = 'trusted' | 'queried' | 'computed' | 'unverified' | 'stale' | 'missing'

export type LabelDeps = {
  fs: Pick<FsPort, 'readdir' | 'readFile'>
  root: string
  /** The commit that last changed trusted calculation `name`; undefined when unknown. Without it nothing is stale. */
  currentCommit?: (name: string) => Promise<string | undefined>
}

const join = (...parts: string[]) => parts.map((part, i) => (i === 0 ? stripTrailingSlashes(part) : part)).join('/')

/** The key `citationLabels` files a citation under. */
export const citationKey = (citation: Citation) => `${citation.analysis} q ${String(citation.number)}`

export async function citationLabel(deps: LabelDeps, citation: Citation): Promise<CitationLabel> {
  const { fs } = deps
  const folder = join(deps.root, 'analyses', citation.analysis)
  const queries = join(folder, 'queries')
  const names = await fs.readdir(queries).catch(() => undefined)
  if (!names) return 'missing'
  const run = parseRuns(names).find(each => each.number === citation.number)
  if (!run || (run.code === undefined && run.data === undefined && run.result === undefined)) return 'missing'
  if (run.language === 'python') {
    const text = run.result ? await fs.readFile(join(queries, run.result)).catch(() => '') : ''
    return parseRunResult(text)?.status === 'ok' ? 'computed' : 'unverified'
  }
  if (!run.data) return 'unverified'
  const code = run.code ? await fs.readFile(join(queries, run.code)).catch(() => '') : ''
  const header = parseTrustedHeader(code)
  if (!header) return 'queried'
  const current = await deps.currentCommit?.(header.name)
  return current !== undefined && current !== header.commit ? 'stale' : 'trusted'
}

/** Labels for the distinct citations, by `citationKey`. */
export async function citationLabels(deps: LabelDeps, citations: readonly Citation[]): Promise<Map<string, CitationLabel>> {
  const distinct = new Map(citations.map(citation => [citationKey(citation), citation]))
  const labels = await Promise.all([...distinct.values()].map(citation => citationLabel(deps, citation)))
  return new Map([...distinct.keys()].map((key, i) => [key, labels[i] ?? 'missing']))
}

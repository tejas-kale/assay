// The analysis state main sends a view: threads, runs, notes, the latest trust review and the overview. Each kind of
// file is read by its own module (runFiles, noteFiles, overviewFiles, requestFiles); paths here always come from
// main's own state, never from the renderer.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { AnalysisRef } from '../core/analyses.ts'
import { jsonFileNames } from '../core/nameOrder.ts'
import { parseRunStatus } from '../core/runs.ts'
import { parseThreads } from '../core/threads.ts'
import { latestReview, parseTrustReview } from '../core/trust.ts'
import type { TrustReview } from '../core/trust.ts'
import type { AnalysisState } from '../shared/ipc.ts'
import { readText, rootOf } from './fsAccess.ts'
import { readNoteLists, readRootNotes } from './noteFiles.ts'
import { readOverview } from './overviewFiles.ts'
import { RUN_STATUS, readQueryNames, readRunsWithHeaders } from './runFiles.ts'

export const THREADS = 'threads.md'
/** Written by the mod when the app started a trust review: one `<name>.json` per review. */
export const TRUST_DIR = '.assay/trust'

/** The latest review in `.assay/trust/`; a missing folder, a half-written file or a bad one is skipped. */
async function readLatestTrust(folder: string): Promise<TrustReview | undefined> {
  const dir = join(folder, TRUST_DIR)
  let names: string[]
  try {
    names = jsonFileNames(await readdir(dir))
  } catch {
    return undefined
  }
  const reviews = await Promise.all(names.map(async n => parseTrustReview(await readText(join(dir, n)).catch(() => ''))))
  return latestReview(reviews.filter((r): r is TrustReview => r !== undefined))
}

export async function loadState(analysis: AnalysisRef): Promise<AnalysisState> {
  const root = rootOf(analysis.path)
  const [threads, queries, status, rootNotes, noteLists, trust, overview] = await Promise.all([
    readText(join(analysis.path, THREADS)),
    readQueryNames(analysis.path),
    readText(join(analysis.path, RUN_STATUS)).catch(() => ''),
    readRootNotes(root),
    readNoteLists(analysis.path),
    readLatestTrust(analysis.path),
    readOverview(analysis.path),
  ])
  return {
    analysis,
    threads: parseThreads(threads),
    runs: await readRunsWithHeaders(analysis.path, queries),
    runStatus: parseRunStatus(status),
    rootNotes,
    noteLists,
    ...(trust && { trust }),
    overview,
  }
}

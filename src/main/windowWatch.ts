// What an attached view watches in its analysis folder: files the app and the server write change the state, and
// the reply files the server writes are delivered to the view.
import { join } from 'node:path'

import { ANALYSIS_FILE } from '../core/analyses.ts'
import { pollFiles, pollSignature } from '../core/watch.ts'
import { CHANNELS } from '../shared/ipc.ts'
import { THREADS, TRUST_DIR } from './files.ts'
import { watchPort, rootOf } from './fsAccess.ts'
import { notesSignature } from './noteFiles.ts'
import { overviewSignature } from './overviewFiles.ts'
import { REPLIES_DIR, takeReplies } from './requestFiles.ts'
import { QUERIES, RUN_STATUS } from './runFiles.ts'
import { send } from './windowState.ts'
import type { WindowCtx } from './windowState.ts'

const REPLY_RETRY_MS = 500

/** Delivers each waiting reply to the view once, and looks again soon while one is half written. */
function deliverReplies(ctx: WindowCtx, analysisPath: string) {
  void takeReplies(analysisPath).then(({ replies, waiting }) => {
    for (const reply of replies) send(ctx, CHANNELS.runReply, reply)
    // Finishing a half-written reply does not change the folder's mtime, so look again.
    if (waiting && !ctx.disposed) setTimeout(() => { deliverReplies(ctx, analysisPath) }, REPLY_RETRY_MS)
  })
}

/** Starts every poll for the analysis; `onChange` pushes the state. Returns the function that stops them all. */
export function watchAnalysis(ctx: WindowCtx, analysisPath: string, onChange: () => void): () => void {
  // The queries folder's mtime changes when a run's file is added or renamed into place.
  const stopState = pollFiles(watchPort, [ANALYSIS_FILE, THREADS, QUERIES, RUN_STATUS, TRUST_DIR].map(name => join(analysisPath, name)), onChange)
  // A reply file's arrival changes the folder's mtime; each one is delivered once, then deleted.
  const stopReplies = pollFiles(watchPort, [join(analysisPath, REPLIES_DIR)], () => {
    deliverReplies(ctx, analysisPath)
  })
  // Replies that were already waiting when the view attached.
  deliverReplies(ctx, analysisPath)
  // A note edited in place leaves the folder's mtime alone, so the names, sizes and mtimes in `<root>/notes` are compared.
  const stopNotes = pollSignature(watchPort, () => notesSignature(rootOf(analysisPath)), onChange)
  // The overview, the system overview it names and their baselines (specs/slices/slice-10.md); Claude's Edit writes in place.
  const stopOverview = pollSignature(watchPort, () => overviewSignature(analysisPath), onChange)
  return () => {
    stopState()
    stopReplies()
    stopNotes()
    stopOverview()
  }
}

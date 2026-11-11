// An analysis in a view: attaching it (the view becomes its workspace), pushing its state, and starting Claude in it.
// The window and its views are windowViews.ts; every analysis's state and files are files.ts and its neighbours.
import { nativeTheme } from 'electron'
import { dirname } from 'node:path'

import { openAnalysis } from '../core/analyses.ts'
import type { AnalysisRef } from '../core/analyses.ts'
import { EMPTY_SET, MAX_ANALYSES, openAnalysisIn } from '../core/analysisSet.ts'
import { spawnSpec } from '../core/session.ts'
import type { TrustReview } from '../core/trust.ts'
import { trustAnnouncement } from '../core/trustAnnouncement.ts'
import { CHANNELS } from '../shared/ipc.ts'
import type { OpenResult, PtyExit } from '../shared/ipc.ts'
import { loadState } from './files.ts'
import { fsPort } from './fsAccess.ts'
import { launchPaths } from './runtime.ts'
import { startSession } from './session.ts'
import { analysisRoot } from './settings.ts'
import { readSavedSet, setSet } from './windowFrame.ts'
import { closeNow, createHost, createView, disposeView, openPicker, show } from './windowViews.ts'
import { refreshStrip } from './windowStrip.ts'
import { allContexts, ctxForPath, send, windowState } from './windowState.ts'
import type { Host, WindowCtx } from './windowState.ts'
import { watchAnalysis } from './windowWatch.ts'

/** The window, created on first use. With `restore`, reopens the analyses open at the last quit. */
export function ensureWindow(restore = false): Host {
  const existing = windowState.host
  if (existing) return existing
  const h = createHost()
  void openSavedAnalyses(h, restore)
  return h
}

/** Opens each saved analysis in a view of its own, or the picker when none opens. */
async function openSavedAnalyses(h: Host, restore: boolean) {
  const saved = restore ? await readSavedSet() : EMPTY_SET
  let opened = false
  for (const path of saved.paths) {
    const analysis = await openAnalysis(fsPort, path).catch(() => undefined)
    if (!analysis || windowState.host !== h) continue
    attachAnalysis(createView(), analysis)
    opened = true
  }
  if (windowState.host !== h) return
  if (!opened) {
    openPicker()
    return
  }
  const current = ctxForPath(saved.current) ? saved.current : h.set.paths[0]
  setSet({ ...h.set, current })
  show(ctxForPath(current))
}

export async function pushState(ctx: WindowCtx) {
  if (!ctx.analysis) return
  try {
    const state = await loadState(ctx.analysis)
    announceTrust(ctx, state.trust)
    send(ctx, CHANNELS.stateChanged, state)
  } catch (err) {
    console.error('Could not read analysis state', err)
  }
}

/** Tells Claude's session how a Trust tab review ended (core/trustAnnouncement.ts), so neither answer needs typing by hand. */
function announceTrust(ctx: WindowCtx, review: TrustReview | undefined) {
  const before = ctx.trust
  ctx.trust = review ?? null
  const text = trustAnnouncement({ before, review, announcedAt: ctx.trustAnnounced })
  if (text === undefined || !review) return
  ctx.trustAnnounced = review.startedAt
  if (ctx.session?.flow.state() === 'running') ctx.session.write(text)
}

/** The view that already holds `analysis`, which a second attach shows instead. */
function showHolder(h: Host, ctx: WindowCtx, other: WindowCtx, analysis: AnalysisRef): OpenResult {
  if (h.picker === ctx) disposeView(ctx, false)
  const opened = openAnalysisIn(h.set, analysis.path)
  if (opened.ok) setSet(opened.set)
  show(other)
  return { ok: true, outcome: 'focused-other-window', path: analysis.path }
}

/**
 * Makes this view the workspace for `analysis` and adds it to the set, or shows the view that already holds it.
 * Refused with nine open.
 */
export function attachAnalysis(ctx: WindowCtx, analysis: AnalysisRef): OpenResult {
  const h = windowState.host
  if (!h) return { ok: false, message: 'The window is closing' }
  const other = allContexts().find(c => c !== ctx && c.analysis?.path === analysis.path)
  if (other) return showHolder(h, ctx, other, analysis)
  if (ctx.analysis) {
    if (ctx.analysis.path === analysis.path) return { ok: true, outcome: 'opened', path: analysis.path }
    return { ok: false, message: 'This view already holds an analysis. Use Cmd+N for another.' }
  }
  const opened = openAnalysisIn(h.set, analysis.path)
  if (!opened.ok) return { ok: false, message: `${String(MAX_ANALYSES)} analyses are open. Close one with Cmd+W to open another.` }
  ctx.analysis = analysis
  if (h.picker === ctx) h.picker = undefined
  setSet(opened.set)
  show(ctx)
  ctx.stopPoll = watchAnalysis(ctx, analysis.path, () => {
    void pushState(ctx)
  })
  return { ok: true, outcome: 'opened', path: analysis.path }
}

/** The view's analysis, unless a session started or the view went while the backend was being looked up. */
function startableAnalysis(ctx: WindowCtx): AnalysisRef | undefined {
  return ctx.session || ctx.disposed ? undefined : ctx.analysis
}

/** Spawns Claude at the renderer's size, once this version's backend is installed. Does nothing without an analysis or when already started. */
export async function startPty(ctx: WindowCtx, cols: number, rows: number) {
  const first = ctx.analysis
  if (!first || ctx.session || ctx.isStarting) return
  ctx.isStarting = true
  // The Settings folder is the root: Claude starts there, and an analysis sits two below it.
  const root = (await analysisRoot().catch(() => undefined)) ?? dirname(dirname(first.path))
  const launch = await launchPaths().catch(() => undefined)
  ctx.isStarting = false
  const analysis = startableAnalysis(ctx)
  if (!analysis) return
  if (!launch) {
    send(ctx, CHANNELS.ptyData, "\r\nAssay's backend is not installed: open Settings (⌘,) and see the Doctor.\r\n")
    send(ctx, CHANNELS.ptyExit, { exitCode: 1 })
    return
  }
  const spec = spawnSpec({ folder: analysis.path, env: process.env, root, mode: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', ...launch })
  try {
    ctx.session = startSession(spec, cols, rows, {
      onData: data => {
        send(ctx, CHANNELS.ptyData, data)
      },
      onExit: (exit: PtyExit) => {
        send(ctx, CHANNELS.ptyExit, exit)
      },
    })
    ctx.session.flow.onChange(state => {
      send(ctx, CHANNELS.closeState, state)
      if (state === 'exited' && ctx.closeRequested) closeNow(ctx)
      void refreshStrip()
    })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    send(ctx, CHANNELS.ptyData, `\r\nCould not start the session: ${text.replace(/\r?\n/g, '\r\n')}\r\n`)
    send(ctx, CHANNELS.ptyExit, { exitCode: 1 })
  }
}

// What the window modules share: the one window (the host), every analysis's view (the contexts) and how to reach
// them. One window holds up to nine analyses (core/analysisSet.ts). All per-view state (pty, poller) lives in a
// WindowCtx found from the sender's webContents, never from anything the renderer sends.
import type { BaseWindow, WebContents, WebContentsView } from 'electron'

import type { AnalysisRef } from '../core/analyses.ts'
import type { AnalysisSet } from '../core/analysisSet.ts'
import type { cmdHold } from '../core/cmdHold.ts'
import type { StripPrefs } from '../core/strip.ts'
import type { TrustReview } from '../core/trust.ts'
import type { PtySession } from './session.ts'

export type WindowCtx = {
  view: WebContentsView
  /** webContents id, kept because `view.webContents` throws once destroyed. */
  id: number
  analysis: AnalysisRef | undefined
  session: PtySession | undefined
  stopPoll: (() => void) | undefined
  /** The user (or Cmd+Q) asked to close while the session ran: close the view when it exits. */
  closeRequested: boolean
  /** Set while startPty looks up the Settings folder, so two calls cannot both spawn. */
  isStarting?: boolean
  dialogOpen: boolean
  disposed: boolean
  /** The latest review the view was sent (null: none yet), to see a check end. Undefined before the first look. */
  trust?: TrustReview | null
  /** The startedAt of the review already told to Claude, so a late poll cannot say it twice. */
  trustAnnounced?: number
}

export type Host = {
  win: BaseWindow
  strip: WebContentsView
  set: AnalysisSet
  /** A view on the picker, not yet in the set (Cmd+N, or the window with nothing open). */
  picker: WindowCtx | undefined
  /** Closing every analysis (Cmd+Q or the window's close button): the set is not saved again until the window is gone. */
  closingAll: boolean
  stopStrip: () => void
  /** Settings > Strip: its side (the palette's Move analysis strip flips it too), what entries show, auto-hide. */
  stripPrefs: StripPrefs
}

const contexts = new Map<number, WindowCtx>()

export function registerContext(ctx: WindowCtx) {
  contexts.set(ctx.id, ctx)
}
export function forgetContext(ctx: WindowCtx) {
  contexts.delete(ctx.id)
}

export const windowState: {
  host: Host | undefined
  /** The Cmd key's hold timer, which shows the shortcut hints. */
  hold: ReturnType<typeof cmdHold> | undefined
  onClosed: (() => void) | undefined
} = { host: undefined, hold: undefined, onClosed: undefined }

export const setOnClosed = (cb: () => void) => {
  windowState.onClosed = cb
}
export const allContexts = () => [...contexts.values()]
export const contextFor = (sender: WebContents) => contexts.get(sender.id)
export const ctxForPath = (path: string | undefined) => allContexts().find(c => c.analysis?.path === path)
/** The window, for dialogs. */
export const hostWindow = () => windowState.host?.win
/** True while the view's pty has not exited. */
export const isLive = (ctx: WindowCtx) => ctx.session !== undefined && ctx.session.flow.state() !== 'exited'

/** The view the window shows: the picker while it is open, else the current analysis. */
export function shownCtx(): WindowCtx | undefined {
  const host = windowState.host
  if (!host) return undefined
  return host.picker ?? ctxForPath(host.set.current)
}

export function send(ctx: WindowCtx, channel: string, ...args: unknown[]) {
  if (ctx.disposed || ctx.view.webContents.isDestroyed()) return
  ctx.view.webContents.send(channel, ...args)
}

export function sendStrip(channel: string, ...args: unknown[]) {
  const host = windowState.host
  if (host && !host.strip.webContents.isDestroyed()) host.strip.webContents.send(channel, ...args)
}

/** Sends an event to every view. */
export function broadcast(channel: string, ...args: unknown[]) {
  for (const ctx of contexts.values()) send(ctx, channel, ...args)
}

// The window and its views: creating the window, a view on the picker, showing one view while the others keep
// running, and closing views. A view starts on the picker and becomes a workspace once an analysis is attached
// (windows.ts). Each analysis is its own WebContentsView running the whole renderer, so a hidden one keeps its
// terminal, kernel, runs and UI state; Cmd+1..9 only changes which view is visible.
import { BaseWindow, WebContentsView, dialog } from 'electron'

import { MAX_ANALYSES, EMPTY_SET, closeAnalysis, switchTo } from '../core/analysisSet.ts'
import { cmdHold } from '../core/cmdHold.ts'
import { analysisNumber, commandForInput } from '../core/keymap.ts'
import type { CommandId } from '../core/keymap.ts'
import { KILL_AFTER_MS } from '../core/session.ts'
import { DEFAULT_STRIP } from '../core/strip.ts'
import { afterLastView, closeAction } from '../core/windowClose.ts'
import { CHANNELS } from '../shared/ipc.ts'
import type { PtySession } from './session.ts'
import { readSettings } from './settings.ts'
import { layout, setSet } from './windowFrame.ts'
import { guardPage, loadPage, webPreferences, windowBackground } from './windowPages.ts'
import { STRIP_MS, refreshStrip, toggleStripSide } from './windowStrip.ts'
import { allContexts, ctxForPath, forgetContext, isLive, registerContext, send, sendStrip, shownCtx, windowState } from './windowState.ts'
import type { Host, WindowCtx } from './windowState.ts'

// --- keys ---

type Input = { type: string; code: string; key: string; meta: boolean; shift: boolean; control: boolean; alt: boolean; isAutoRepeat: boolean }

function handleInput(ctx: WindowCtx | undefined, hold: ReturnType<typeof cmdHold>, event: { preventDefault(): void }, input: Input) {
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return
  hold.key(input.type, input.code)
  const id = commandForInput({ key: input.key, code: input.code, meta: input.meta, shift: input.shift, ctrl: input.control, alt: input.alt })
  if (!id) return
  // The terminal sees neither half of a claimed shortcut; only a first keyDown runs it.
  event.preventDefault()
  if (input.type !== 'keyDown' || input.isAutoRepeat) return
  runWindowCommand(id, ctx ?? shownCtx())
}

/** Commands main runs itself; the rest go to the view's renderer. */
function runWindowCommand(id: CommandId, ctx: WindowCtx | undefined) {
  const n = analysisNumber(id)
  if (n !== undefined) showAnalysis(n)
  else if (id === 'analysis.new') openPicker()
  else if (id === 'strip.side') toggleStripSide()
  else if (id === 'analysis.close') {
    if (ctx) requestClose(ctx)
  } else if (ctx) send(ctx, CHANNELS.command, id)
}

// --- the window ---

/** The window, which exists once any view does. */
const ensureHost = (): Host => windowState.host ?? createHost()

/** Shows the shortcut hints in the shown view and the strip while Cmd is held. */
function createHold() {
  return cmdHold({
    onChange: kind => {
      const shown = shownCtx()
      if (shown) send(shown, CHANNELS.hints, kind)
      sendStrip(CHANNELS.hints, kind)
    },
    setTimer(cb, ms) {
      const t = setTimeout(cb, ms)
      return () => {
        clearTimeout(t)
      }
    },
  })
}

/** The window, with its strip view on the strip page. A first call also takes over the window's events. */
export function createHost(): Host {
  const win = new BaseWindow({ width: 1500, height: 900, show: false, title: 'Assay', backgroundColor: windowBackground() })
  const strip = new WebContentsView({ webPreferences })
  guardPage(strip.webContents)
  win.contentView.addChildView(strip)
  const timer = setInterval(() => {
    void refreshStrip()
  }, STRIP_MS)
  const h: Host = {
    win,
    strip,
    set: EMPTY_SET,
    picker: undefined,
    closingAll: false,
    stopStrip: () => {
      clearInterval(timer)
    },
    stripPrefs: DEFAULT_STRIP,
  }
  windowState.host = h
  void readSettings().then(settings => {
    h.stripPrefs = settings.strip
    layout()
    void refreshStrip()
  })
  const hold = createHold()
  windowState.hold = hold
  strip.webContents.on('before-input-event', (event, input) => {
    handleInput(undefined, hold, event, input)
  })
  wireWindowEvents(h, hold)
  loadPage(strip.webContents, 'strip')
  strip.webContents.once('did-finish-load', () => {
    void refreshStrip()
  })
  layout()
  win.show()
  return h
}

function wireWindowEvents(h: Host, hold: ReturnType<typeof cmdHold>) {
  h.win.on('blur', () => {
    hold.blur()
  })
  h.win.on('resize', layout)
  h.win.on('close', event => {
    // From here on the set is the one to restore at the next launch; closing the views must not empty it.
    h.closingAll = true
    if (allContexts().every(ctx => !isLive(ctx))) return
    // Every session must finish its import first; the last view to go closes the window.
    event.preventDefault()
    closeAll()
  })
  h.win.on('closed', () => {
    h.closingAll = true
    h.stopStrip()
    hold.blur()
    windowState.hold = undefined
    for (const ctx of allContexts()) disposeView(ctx, false)
    windowState.host = undefined
    windowState.onClosed?.()
  })
}

/** Shows `ctx` (every other view is hidden but keeps running) and gives it the keyboard. */
export function show(ctx: WindowCtx | undefined) {
  const host = windowState.host
  if (!host || !ctx) return
  for (const other of allContexts()) other.view.setVisible(other === ctx)
  host.win.setTitle(ctx.analysis ? `${ctx.analysis.title} — Assay` : 'Assay')
  if (!ctx.view.webContents.isDestroyed()) ctx.view.webContents.focus()
  void refreshStrip()
}

/** A new view on the picker page, hidden until shown. */
export function createView(): WindowCtx {
  const h = ensureHost()
  // Hidden views must keep running at full speed: Claude's output and run replies arrive while they are hidden.
  const view = new WebContentsView({ webPreferences: { ...webPreferences, backgroundThrottling: false } })
  view.setBackgroundColor(windowBackground())
  view.setVisible(false)
  const ctx: WindowCtx = {
    view,
    id: view.webContents.id,
    analysis: undefined,
    session: undefined,
    stopPoll: undefined,
    closeRequested: false,
    dialogOpen: false,
    disposed: false,
  }
  registerContext(ctx)
  guardPage(view.webContents)
  view.webContents.on('before-input-event', (event, input) => {
    if (windowState.hold) handleInput(ctx, windowState.hold, event, input)
  })
  // The strip stays the top view, so a view added later never covers it.
  h.win.contentView.addChildView(view, 0)
  layout()
  loadPage(view.webContents)
  return ctx
}

/** After Rename analysis: the window title follows when it is the shown one. */
export function retitle(ctx: WindowCtx) {
  const host = windowState.host
  if (host && shownCtx() === ctx && ctx.analysis) host.win.setTitle(`${ctx.analysis.title} — Assay`)
  void refreshStrip()
}

/** Cmd+1..9 and a click on the strip. A number with no analysis does nothing. */
export function showAnalysis(n: number) {
  const host = windowState.host
  if (!host) return
  const next = switchTo(host.set, n)
  // The shown one again (a click on its strip entry) only takes the keyboard back from the strip.
  if (next === host.set && !host.picker) {
    show(shownCtx())
    return
  }
  const target = ctxForPath(next.current)
  if (!target) return
  if (host.picker) disposeView(host.picker)
  setSet(next)
  show(target)
}

/** Cmd+N: the picker, in a view of its own. Refused with nine analyses open, so every one keeps a shortcut. */
export function openPicker() {
  const h = ensureHost()
  if (h.picker) {
    show(h.picker)
    return
  }
  if (h.set.paths.length >= MAX_ANALYSES) {
    void dialog.showMessageBox(h.win, {
      type: 'info',
      message: `${String(MAX_ANALYSES)} analyses are open`,
      detail: 'Close one with Cmd+W to open another.',
    })
    return
  }
  h.picker = createView()
  show(h.picker)
}

// --- closing ---

/** Takes the view out of the window and stops what runs in it. */
function releaseView(ctx: WindowCtx) {
  ctx.disposed = true
  ctx.stopPoll?.()
  ctx.session?.dispose()
  forgetContext(ctx)
  const host = windowState.host
  if (host && !host.win.isDestroyed()) host.win.contentView.removeChildView(ctx.view)
  if (!ctx.view.webContents.isDestroyed()) ctx.view.webContents.close()
}

/** Removes a view for good. Its session must already have exited (or never started). */
export function disposeView(ctx: WindowCtx, reshow = true) {
  if (ctx.disposed) return
  releaseView(ctx)
  const h = windowState.host
  if (!h) return
  const wasPicker = h.picker === ctx
  if (wasPicker) h.picker = undefined
  else if (ctx.analysis) setSet(closeAnalysis(h.set, ctx.analysis.path))
  if (!reshow || h.win.isDestroyed()) return
  if (allContexts().length > 0) show(shownCtx())
  else if (afterLastView(h.closingAll, wasPicker) === 'end-window') {
    h.closingAll = true
    h.win.destroy()
  } else openPicker()
  windowState.onClosed?.()
}

/** Cmd+Q and the window's close button: every analysis closes, and the window with the last one. */
export function closeAll() {
  const host = windowState.host
  if (!host) return
  host.closingAll = true
  const views = allContexts()
  if (views.length === 0) host.win.destroy()
  for (const ctx of views) requestClose(ctx)
}

/**
 * Cmd+W, the palette and closeAll end here. No live session: the view goes at once. Running: start the graceful
 * close and wait for the pty to exit. Already closing: ask.
 */
export function requestClose(ctx: WindowCtx) {
  const session = ctx.session
  const action = closeAction(session?.flow.state())
  if (action === 'close-now' || !session) closeNow(ctx)
  else if (action === 'start-close') {
    ctx.closeRequested = true
    session.flow.start()
  } else void confirmForce(ctx, session)
}

export function closeNow(ctx: WindowCtx) {
  // confirmForce closes the view itself once the dialog is answered and the session has exited.
  if (ctx.dialogOpen) return
  disposeView(ctx)
}

async function confirmForce(ctx: WindowCtx, session: PtySession) {
  const host = windowState.host
  if (ctx.dialogOpen || !host || host.win.isDestroyed()) return
  ctx.dialogOpen = true
  try {
    const { response } = await dialog.showMessageBox(host.win, {
      type: 'warning',
      message: `Still waiting for ${ctx.analysis?.title ?? 'the session'} to finish`,
      detail: 'The wrapper is importing the session, or Claude Code did not exit. Force quit ends it (SIGHUP, then SIGKILL) and may skip the import.',
      buttons: ['Keep waiting', 'Force quit'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response === 1 && session.flow.state() === 'closing') {
      session.flow.forceKill()
      // Force quit must close the view even if the process never reports its exit.
      setTimeout(() => {
        if (session.flow.state() !== 'exited') closeNow(ctx)
      }, KILL_AFTER_MS + 1000)
    }
    // Keep waiting changes nothing: a quit or restart under way still ends once this session exits, and the open
    // set stays as it was when it began, so the next launch reopens all of it.
  } finally {
    ctx.dialogOpen = false
  }
  if (session.flow.state() === 'exited') closeNow(ctx)
}

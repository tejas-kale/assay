// One BrowserWindow per analysis. A window starts on the picker and becomes a workspace once an
// analysis is attached. All per-window state (pty, poller) lives in a WindowCtx found from the
// sender's webContents, never from anything the renderer sends.
import { BrowserWindow, dialog, nativeTheme } from 'electron'
import type { WebContents } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cmdHold } from '../core/cmdHold.ts'
import { commandForInput } from '../core/keymap.ts'
import { spawnSpec } from '../core/session.ts'
import { THEMES } from '../core/theme.ts'
import { pollFiles } from '../core/watch.ts'
import { CHANNELS } from '../shared/ipc.ts'
import type { OpenResult, PtyExit } from '../shared/ipc.ts'
import { NOTES, QUERIES, REPLIES_DIR, RUN_STATUS, THREADS, loadState, takeReplies, watchPort } from './files.ts'
import { startSession } from './session.ts'
import type { PtySession } from './session.ts'

export type WindowCtx = {
  win: BrowserWindow
  /** webContents id, kept because `win.webContents` throws once destroyed. */
  id: number
  analysis: { name: string; path: string } | undefined
  session: PtySession | undefined
  stopPoll: (() => void) | undefined
  /** The user (or Cmd+Q) asked to close while the session ran: close the window when it exits. */
  closeRequested: boolean
  /** Lets the next `close` event through. */
  allowClose: boolean
  dialogOpen: boolean
  disposed: boolean
}

const here = fileURLToPath(new URL('.', import.meta.url))
const contexts = new Map<number, WindowCtx>()
let onClosed: (() => void) | undefined
let onKeepWaiting: (() => void) | undefined

export const setOnClosed = (cb: () => void) => {
  onClosed = cb
}
/** Called when the user answers the force-quit dialog with "Keep waiting". */
export const setOnKeepWaiting = (cb: () => void) => {
  onKeepWaiting = cb
}
export const allContexts = () => [...contexts.values()]
export const contextFor = (sender: WebContents) => contexts.get(sender.id)
/** True while the window's pty has not exited. */
export const isLive = (ctx: WindowCtx) => ctx.session !== undefined && ctx.session.flow.state() !== 'exited'

function send(ctx: WindowCtx, channel: string, ...args: unknown[]) {
  if (ctx.disposed || ctx.win.isDestroyed() || ctx.win.webContents.isDestroyed()) return
  ctx.win.webContents.send(channel, ...args)
}

/** Sends an event to every open window. */
export function broadcast(channel: string, ...args: unknown[]) {
  for (const ctx of contexts.values()) send(ctx, channel, ...args)
}

const windowBackground = () => THEMES[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].ui.bg

/** Keeps the colour a window shows before and around its page in step with the system. */
export function followSystemTheme() {
  nativeTheme.on('updated', () => {
    for (const ctx of contexts.values()) {
      if (!ctx.win.isDestroyed()) ctx.win.setBackgroundColor(windowBackground())
    }
  })
}

export function createWindow(): WindowCtx {
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    show: false,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const ctx: WindowCtx = {
    win,
    id: win.webContents.id,
    analysis: undefined,
    session: undefined,
    stopPoll: undefined,
    closeRequested: false,
    allowClose: false,
    dialogOpen: false,
    disposed: false,
  }
  contexts.set(ctx.id, ctx)
  const wc = win.webContents

  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Only a reload of the page itself may navigate.
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (url !== wc.getURL()) event.preventDefault()
  }
  wc.on('will-navigate', (event, url) => guard(event, url))
  wc.on('will-redirect', (event, url) => guard(event, url))
  wc.on('will-attach-webview', event => event.preventDefault())

  const hold = cmdHold({
    onChange: visible => send(ctx, CHANNELS.hints, visible),
    setTimer(cb, ms) {
      const timer = setTimeout(cb, ms)
      return () => clearTimeout(timer)
    },
  })
  win.on('blur', hold.blur)

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return
    hold.key(input.type, input.code)
    const id = commandForInput({
      key: input.key,
      code: input.code,
      meta: input.meta,
      shift: input.shift,
      ctrl: input.control,
      alt: input.alt,
    })
    if (!id) return
    // The terminal sees neither half of a claimed shortcut; only a first keyDown runs it.
    event.preventDefault()
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    if (id === 'window.new') createWindow()
    else if (id === 'window.close') win.close()
    else send(ctx, CHANNELS.command, id)
  })

  win.on('close', event => {
    // The force-quit dialog is parented to this window: hold the close until it is answered.
    if (ctx.dialogOpen) {
      event.preventDefault()
      return
    }
    if (ctx.allowClose || !isLive(ctx)) return
    event.preventDefault()
    requestClose(ctx)
  })
  win.on('closed', () => {
    ctx.disposed = true
    hold.blur()
    ctx.stopPoll?.()
    ctx.session?.dispose()
    contexts.delete(ctx.id)
    onClosed?.()
  })
  win.once('ready-to-show', () => win.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(here, '../renderer/index.html'))
  return ctx
}

function closeNow(ctx: WindowCtx) {
  // confirmForce closes the window itself once the dialog is answered and the session has exited.
  if (ctx.dialogOpen) return
  ctx.allowClose = true
  if (!ctx.win.isDestroyed()) ctx.win.close()
}

/**
 * The window's close button, Cmd+W, the palette and Cmd+Q all end here. No live session: close
 * at once. Running: start the graceful close and wait for the pty to exit. Already closing: ask.
 */
export function requestClose(ctx: WindowCtx) {
  const session = ctx.session
  if (!session || session.flow.state() === 'exited') {
    closeNow(ctx)
    return
  }
  if (session.flow.state() === 'running') {
    ctx.closeRequested = true
    session.flow.start()
    return
  }
  void confirmForce(ctx, session)
}

async function confirmForce(ctx: WindowCtx, session: PtySession) {
  if (ctx.dialogOpen || ctx.win.isDestroyed()) return
  ctx.dialogOpen = true
  try {
    const { response } = await dialog.showMessageBox(ctx.win, {
      type: 'warning',
      message: 'Still waiting for the session to finish',
      detail: 'The wrapper is importing the session. Force quit sends SIGHUP and may skip that step.',
      buttons: ['Keep waiting', 'Force quit'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response === 1 && session.flow.state() === 'closing') session.flow.forceKill()
    else if (response === 0) onKeepWaiting?.()
  } finally {
    ctx.dialogOpen = false
  }
  if (session.flow.state() === 'exited') closeNow(ctx)
}

export async function pushState(ctx: WindowCtx) {
  if (!ctx.analysis) return
  try {
    const state = await loadState(ctx.analysis)
    send(ctx, CHANNELS.stateChanged, state)
  } catch (err) {
    console.error('Could not read analysis state', err)
  }
}

/** Makes this window the workspace for `analysis`, or focuses the window that already holds it. */
export function attachAnalysis(ctx: WindowCtx, analysis: { name: string; path: string }): OpenResult {
  const other = allContexts().find(c => c !== ctx && c.analysis?.path === analysis.path)
  if (other) {
    if (other.win.isMinimized()) other.win.restore()
    other.win.focus()
    return { ok: true, outcome: 'focused-other-window', path: analysis.path }
  }
  if (ctx.analysis) {
    if (ctx.analysis.path === analysis.path) return { ok: true, outcome: 'opened', path: analysis.path }
    return { ok: false, message: 'This window already holds an analysis. Use Cmd+N for another.' }
  }
  ctx.analysis = analysis
  ctx.stopPoll = pollFiles(
    watchPort,
    // The queries folder's mtime changes when a run's file is added or renamed into place.
    [NOTES, THREADS, QUERIES, RUN_STATUS].map(name => join(analysis.path, name)),
    () => void pushState(ctx),
  )
  // A reply file's arrival changes the folder's mtime; each one is delivered once, then deleted.
  const deliverReplies = () =>
    void takeReplies(analysis.path).then(replies => {
      for (const reply of replies) send(ctx, CHANNELS.runReply, reply)
    })
  const stopReplies = pollFiles(watchPort, [join(analysis.path, REPLIES_DIR)], deliverReplies)
  // Replies that were already waiting when the window attached.
  deliverReplies()
  const stopState = ctx.stopPoll
  ctx.stopPoll = () => {
    stopState()
    stopReplies()
  }
  return { ok: true, outcome: 'opened', path: analysis.path }
}

/** Spawns the wrapper at the renderer's size. Does nothing without an analysis or when already started. */
export function startPty(ctx: WindowCtx, cols: number, rows: number) {
  if (!ctx.analysis || ctx.session) return
  const spec = spawnSpec(ctx.analysis.path, process.env)
  try {
    const session = startSession(spec, cols, rows, {
      onData: data => send(ctx, CHANNELS.ptyData, data),
      onExit: (exit: PtyExit) => send(ctx, CHANNELS.ptyExit, exit),
    })
    ctx.session = session
    session.flow.onChange(state => {
      send(ctx, CHANNELS.closeState, state)
      if (state === 'exited' && ctx.closeRequested) closeNow(ctx)
    })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    send(ctx, CHANNELS.ptyData, `\r\nCould not start the session: ${text.replace(/\r?\n/g, '\r\n')}\r\n`)
    send(ctx, CHANNELS.ptyExit, { exitCode: 1 })
  }
}

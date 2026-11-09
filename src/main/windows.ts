// One window holds up to nine analyses (core/analysisSet.ts). Each analysis is its own WebContentsView running the
// whole renderer, so a hidden one keeps its terminal, kernel, runs and UI state; Cmd+1..9 only changes which view
// is visible. A strip view along the bottom shows every analysis's Claude state. A view starts on the picker and
// becomes a workspace once an analysis is attached. All per-view state (pty, poller) lives in a WindowCtx found
// from the sender's webContents, never from anything the renderer sends.
import { BaseWindow, WebContentsView, app, dialog, nativeTheme } from 'electron'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ANALYSIS_FILE, openAnalysis } from '../core/analyses.ts'
import type { AnalysisRef } from '../core/analyses.ts'
import { EMPTY_SET, MAX_ANALYSES, closeAnalysis, openAnalysisIn, restoreSet, switchTo } from '../core/analysisSet.ts'
import type { AnalysisSet } from '../core/analysisSet.ts'
import { CLAUDE_STATE, readClaudeState } from '../core/claudeState.ts'
import { cmdHold } from '../core/cmdHold.ts'
import { analysisNumber, commandForInput } from '../core/keymap.ts'
import type { CommandId } from '../core/keymap.ts'
import { parseRunStatus } from '../core/runs.ts'
import { KILL_AFTER_MS, spawnSpec } from '../core/session.ts'
import { stripEntry } from '../core/strip.ts'
import { THEMES } from '../core/theme.ts'
import { failedMessage, justAnswered, justFailed } from '../core/trust.ts'
import type { TrustReview } from '../core/trust.ts'
import { pollFiles, pollSignature } from '../core/watch.ts'
import { CHANNELS } from '../shared/ipc.ts'
import type { OpenResult, PtyExit } from '../shared/ipc.ts'
import { QUERIES, REPLIES_DIR, RUN_STATUS, THREADS, TRUST_DIR, fsPort, loadState, notesSignature, rootOf, takeReplies, watchPort } from './files.ts'
import { startSession } from './session.ts'
import { analysisRoot } from './settings.ts'
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

type Host = {
  win: BaseWindow
  strip: WebContentsView
  set: AnalysisSet
  /** A view on the picker, not yet in the set (Cmd+N, or the window with nothing open). */
  picker: WindowCtx | undefined
  /** Closing every analysis (Cmd+Q or the window's close button): the set is not saved again until the window is gone. */
  closingAll: boolean
  stopStrip: () => void
}

/** Height of the analysis strip, in CSS pixels; the renderer's `.strip` matches it. */
const STRIP_HEIGHT = 26
const STRIP_MS = 1000

const here = fileURLToPath(new URL('.', import.meta.url))
const contexts = new Map<number, WindowCtx>()
let host: Host | undefined
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
/** The window, for dialogs. */
export const hostWindow = () => host?.win
/** True while the view's pty has not exited. */
export const isLive = (ctx: WindowCtx) => ctx.session !== undefined && ctx.session.flow.state() !== 'exited'

function send(ctx: WindowCtx, channel: string, ...args: unknown[]) {
  if (ctx.disposed || ctx.view.webContents.isDestroyed()) return
  ctx.view.webContents.send(channel, ...args)
}

function sendStrip(channel: string, ...args: unknown[]) {
  if (host && !host.strip.webContents.isDestroyed()) host.strip.webContents.send(channel, ...args)
}

/** Sends an event to every view. */
export function broadcast(channel: string, ...args: unknown[]) {
  for (const ctx of contexts.values()) send(ctx, channel, ...args)
}

const windowBackground = () => THEMES[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].ui.bg

/** Keeps the colour the window shows before and around its views in step with the system. */
export function followSystemTheme() {
  nativeTheme.on('updated', () => {
    if (host && !host.win.isDestroyed()) host.win.setBackgroundColor(windowBackground())
  })
}

function loadPage(wc: WebContents, hash?: string) {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void wc.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  else void wc.loadFile(join(here, '../renderer/index.html'), hash ? { hash } : {})
}

/** The rules every page here follows: no new windows, no navigation away, no webviews. */
function guardPage(wc: WebContents) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (url !== wc.getURL()) event.preventDefault()
  }
  wc.on('will-navigate', (event, url) => guard(event, url))
  wc.on('will-redirect', (event, url) => guard(event, url))
  wc.on('will-attach-webview', event => event.preventDefault())
}

const webPreferences = {
  preload: join(here, '../preload/index.cjs'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
}

// --- the open set, saved for the next launch ---

const savedSetPath = () => join(app.getPath('userData'), 'open-analyses.json')

async function readSavedSet(): Promise<AnalysisSet> {
  try {
    const parsed: unknown = JSON.parse(await readFile(savedSetPath(), 'utf8'))
    const paths: unknown = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'paths') : undefined
    const current: unknown = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'current') : undefined
    if (!Array.isArray(paths)) return EMPTY_SET
    return restoreSet({ paths: paths.filter((p): p is string => typeof p === 'string'), current: typeof current === 'string' ? current : undefined })
  } catch {
    return EMPTY_SET
  }
}

function saveSet(set: AnalysisSet) {
  const temp = `${savedSetPath()}.${randomUUID()}.tmp`
  void writeFile(temp, JSON.stringify(set))
    .then(() => rename(temp, savedSetPath()))
    .catch(err => console.error('Could not save the open analyses', err))
}

function setSet(next: AnalysisSet) {
  if (!host) return
  host.set = next
  if (!host.closingAll) saveSet(next)
}

const ctxForPath = (path: string | undefined) => allContexts().find(c => c.analysis?.path === path)

// --- the window ---

/** The window, created on first use. With `restore`, reopens the analyses open at the last quit. */
export function ensureWindow(restore = false): Host {
  if (host) return host
  const win = new BaseWindow({ width: 1500, height: 900, show: false, title: 'Assay', backgroundColor: windowBackground() })
  const strip = new WebContentsView({ webPreferences })
  guardPage(strip.webContents)
  win.contentView.addChildView(strip)
  const timer = setInterval(() => void refreshStrip(), STRIP_MS)
  const h: Host = { win, strip, set: EMPTY_SET, picker: undefined, closingAll: false, stopStrip: () => clearInterval(timer) }
  host = h

  const hold = cmdHold({
    onChange: kind => {
      const shown = shownCtx()
      if (shown) send(shown, CHANNELS.hints, kind)
      sendStrip(CHANNELS.hints, kind)
    },
    setTimer(cb, ms) {
      const t = setTimeout(cb, ms)
      return () => clearTimeout(t)
    },
  })
  win.on('blur', hold.blur)
  strip.webContents.on('before-input-event', (event, input) => handleInput(undefined, hold, event, input))
  hostHold = hold

  win.on('resize', layout)
  win.on('close', event => {
    // From here on the set is the one to restore at the next launch; closing the views must not empty it.
    h.closingAll = true
    if (allContexts().every(ctx => !isLive(ctx))) return
    // Every session must finish its import first; the last view to go closes the window.
    event.preventDefault()
    closeAll()
  })
  win.on('closed', () => {
    h.closingAll = true
    h.stopStrip()
    hold.blur()
    hostHold = undefined
    for (const ctx of allContexts()) disposeView(ctx, false)
    host = undefined
    onClosed?.()
  })
  loadPage(strip.webContents, 'strip')
  strip.webContents.once('did-finish-load', () => void refreshStrip())
  layout()
  win.show()

  void (async () => {
    const saved = restore ? await readSavedSet() : EMPTY_SET
    let opened = false
    for (const path of saved.paths) {
      const analysis = await openAnalysis(fsPort, path).catch(() => undefined)
      if (!analysis || host !== h) continue
      const ctx = createView()
      attachAnalysis(ctx, analysis)
      opened = true
    }
    if (host !== h) return
    if (!opened) openPicker()
    else {
      const current = ctxForPath(saved.current) ? saved.current : h.set.paths[0]
      setSet({ ...h.set, current })
      show(ctxForPath(current))
    }
  })()
  return h
}

let hostHold: ReturnType<typeof cmdHold> | undefined

function layout() {
  if (!host) return
  const { width, height } = host.win.getContentBounds()
  const main = { x: 0, y: 0, width, height: Math.max(0, height - STRIP_HEIGHT) }
  for (const ctx of allContexts()) ctx.view.setBounds(main)
  host.strip.setBounds({ x: 0, y: main.height, width, height: STRIP_HEIGHT })
}

/** The view the window shows: the picker while it is open, else the current analysis. */
function shownCtx(): WindowCtx | undefined {
  if (!host) return undefined
  return host.picker ?? ctxForPath(host.set.current)
}

/** Shows `ctx` (every other view is hidden but keeps running) and gives it the keyboard. */
function show(ctx: WindowCtx | undefined) {
  if (!host || !ctx) return
  for (const other of allContexts()) other.view.setVisible(other === ctx)
  host.win.setTitle(ctx.analysis ? `${ctx.analysis.title} — Assay` : 'Assay')
  if (!ctx.view.webContents.isDestroyed()) ctx.view.webContents.focus()
  void refreshStrip()
}

/** A new view on the picker page, hidden until shown. */
function createView(): WindowCtx {
  const h = ensureWindow()
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
  contexts.set(ctx.id, ctx)
  guardPage(view.webContents)
  view.webContents.on('before-input-event', (event, input) => {
    if (hostHold) handleInput(ctx, hostHold, event, input)
  })
  // The strip stays the top view, so a view added later never covers it.
  h.win.contentView.addChildView(view, 0)
  layout()
  loadPage(view.webContents)
  return ctx
}

type InputEvent = { preventDefault(): void }
type Input = { type: string; code: string; key: string; meta: boolean; shift: boolean; control: boolean; alt: boolean; isAutoRepeat: boolean }

function handleInput(ctx: WindowCtx | undefined, hold: ReturnType<typeof cmdHold>, event: InputEvent, input: Input) {
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
  else if (id === 'analysis.close') {
    if (ctx) requestClose(ctx)
  } else if (ctx) send(ctx, CHANNELS.command, id)
}

/** Cmd+1..9 and a click on the strip. A number with no analysis does nothing. */
export function showAnalysis(n: number) {
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
  const h = ensureWindow()
  if (h.picker) {
    show(h.picker)
    return
  }
  if (h.set.paths.length >= MAX_ANALYSES) {
    void dialog.showMessageBox(h.win, {
      type: 'info',
      message: `${MAX_ANALYSES} analyses are open`,
      detail: 'Close one with Cmd+W to open another.',
    })
    return
  }
  h.picker = createView()
  show(h.picker)
}

/** Removes a view for good. Its session must already have exited (or never started). */
function disposeView(ctx: WindowCtx, reshow = true) {
  if (ctx.disposed) return
  ctx.disposed = true
  ctx.stopPoll?.()
  ctx.session?.dispose()
  contexts.delete(ctx.id)
  const h = host
  if (h && !h.win.isDestroyed()) h.win.contentView.removeChildView(ctx.view)
  if (!ctx.view.webContents.isDestroyed()) ctx.view.webContents.close()
  if (!h) return
  const wasPicker = h.picker === ctx
  if (wasPicker) h.picker = undefined
  else if (ctx.analysis) setSet(closeAnalysis(h.set, ctx.analysis.path))
  if (!reshow || h.win.isDestroyed()) return
  if (allContexts().length === 0) {
    // The last view went. Closing everything, or Cmd+W on a picker with nothing open, ends the window; Cmd+W on
    // the last analysis shows the picker.
    if (h.closingAll || wasPicker) {
      h.closingAll = true
      h.win.destroy()
    } else openPicker()
    onClosed?.()
    return
  }
  show(shownCtx())
  onClosed?.()
}

/** Cmd+Q and the window's close button: every analysis closes, and the window with the last one. */
export function closeAll() {
  if (!host) return
  host.closingAll = true
  const views = allContexts()
  if (views.length === 0) host.win.destroy()
  for (const ctx of views) requestClose(ctx)
}

/** "Keep waiting" on Cmd+Q: the analyses still open stay, and the set is saved again. */
function cancelCloseAll() {
  if (!host) return
  host.closingAll = false
  saveSet(host.set)
}

/**
 * Cmd+W, the palette and closeAll end here. No live session: the view goes at once. Running: start the graceful
 * close and wait for the pty to exit. Already closing: ask.
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

function closeNow(ctx: WindowCtx) {
  // confirmForce closes the view itself once the dialog is answered and the session has exited.
  if (ctx.dialogOpen) return
  disposeView(ctx)
}

async function confirmForce(ctx: WindowCtx, session: PtySession) {
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
    } else if (response === 0) {
      cancelCloseAll()
      onKeepWaiting?.()
    }
  } finally {
    ctx.dialogOpen = false
  }
  if (session.flow.state() === 'exited') closeNow(ctx)
}

// --- the strip ---

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined)
}

async function refreshStrip() {
  const h = host
  if (!h) return
  const now = Date.now()
  const entries = await Promise.all(
    h.set.paths.map(async (path, i) => {
      const ctx = ctxForPath(path)
      const [claude, runs] = await Promise.all([readOptional(join(path, CLAUDE_STATE)), readOptional(join(path, RUN_STATUS))])
      return stripEntry(
        {
          number: i + 1,
          title: ctx?.analysis?.title ?? path,
          claude: readClaudeState(claude),
          // A session not started yet (the view is still loading) counts as live.
          sessionLive: !ctx?.session || ctx.session.flow.state() !== 'exited',
          running: parseRunStatus(runs ?? '').running,
          current: !h.picker && path === h.set.current,
        },
        now,
      )
    }),
  )
  if (host === h) sendStrip(CHANNELS.stripEntries, entries)
}

// --- an analysis in a view ---

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

/**
 * Tells Claude's session how a Trust tab review ended, as if the user typed it: `trusted` or `rejected` once they
 * answer, the failed steps when a check fails, so neither needs typing by hand.
 */
function announceTrust(ctx: WindowCtx, review: TrustReview | undefined) {
  const before = ctx.trust
  ctx.trust = review ?? null
  if (!review || ctx.trustAnnounced === review.startedAt) return
  const answer = justAnswered(before ?? undefined, review)
  const text = answer ? `${answer}\r` : justFailed(before, review) ? failedMessage(review) : undefined
  if (text === undefined) return
  ctx.trustAnnounced = review.startedAt
  if (ctx.session?.flow.state() === 'running') ctx.session.write(text)
}

/**
 * Makes this view the workspace for `analysis` and adds it to the set, or shows the view that already holds it.
 * Refused with nine open.
 */
export function attachAnalysis(ctx: WindowCtx, analysis: AnalysisRef): OpenResult {
  const h = host
  if (!h) return { ok: false, message: 'The window is closing' }
  const other = allContexts().find(c => c !== ctx && c.analysis?.path === analysis.path)
  if (other) {
    if (h.picker === ctx) disposeView(ctx, false)
    const opened = openAnalysisIn(h.set, analysis.path)
    if (opened.ok) setSet(opened.set)
    show(other)
    return { ok: true, outcome: 'focused-other-window', path: analysis.path }
  }
  if (ctx.analysis) {
    if (ctx.analysis.path === analysis.path) return { ok: true, outcome: 'opened', path: analysis.path }
    return { ok: false, message: 'This view already holds an analysis. Use Cmd+N for another.' }
  }
  const opened = openAnalysisIn(h.set, analysis.path)
  if (!opened.ok) return { ok: false, message: `${MAX_ANALYSES} analyses are open. Close one with Cmd+W to open another.` }
  ctx.analysis = analysis
  if (h.picker === ctx) h.picker = undefined
  setSet(opened.set)
  show(ctx)
  ctx.stopPoll = pollFiles(
    watchPort,
    // The queries folder's mtime changes when a run's file is added or renamed into place.
    [ANALYSIS_FILE, THREADS, QUERIES, RUN_STATUS, TRUST_DIR].map(name => join(analysis.path, name)),
    () => void pushState(ctx),
  )
  // A reply file's arrival changes the folder's mtime; each one is delivered once, then deleted.
  const deliverReplies = () =>
    void takeReplies(analysis.path).then(({ replies, waiting }) => {
      for (const reply of replies) send(ctx, CHANNELS.runReply, reply)
      // Finishing a half-written reply does not change the folder's mtime, so look again.
      if (waiting && !ctx.disposed) setTimeout(deliverReplies, 500)
    })
  const stopReplies = pollFiles(watchPort, [join(analysis.path, REPLIES_DIR)], deliverReplies)
  // Replies that were already waiting when the view attached.
  deliverReplies()
  // A note edited in place leaves the folder's mtime alone, so the names, sizes and mtimes in `<root>/notes` are compared.
  const stopNotes = pollSignature(watchPort, () => notesSignature(rootOf(analysis.path)), () => void pushState(ctx))
  const stopState = ctx.stopPoll
  ctx.stopPoll = () => {
    stopState()
    stopReplies()
    stopNotes()
  }
  return { ok: true, outcome: 'opened', path: analysis.path }
}

/** After Rename analysis: the window title follows when it is the shown one. */
export function retitle(ctx: WindowCtx) {
  if (host && shownCtx() === ctx && ctx.analysis) host.win.setTitle(`${ctx.analysis.title} — Assay`)
  void refreshStrip()
}

/** Spawns the wrapper at the renderer's size. Does nothing without an analysis or when already started. */
export async function startPty(ctx: WindowCtx, cols: number, rows: number) {
  if (!ctx.analysis || ctx.session || ctx.isStarting) return
  ctx.isStarting = true
  // The Settings folder is the root: Claude starts there, and an analysis sits two below it.
  const root = (await analysisRoot().catch(() => undefined)) ?? dirname(dirname(ctx.analysis.path))
  ctx.isStarting = false
  if (!ctx.analysis || ctx.session || ctx.disposed) return
  const spec = spawnSpec(ctx.analysis.path, process.env, root, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  try {
    const session = startSession(spec, cols, rows, {
      onData: data => send(ctx, CHANNELS.ptyData, data),
      onExit: (exit: PtyExit) => send(ctx, CHANNELS.ptyExit, exit),
    })
    ctx.session = session
    session.flow.onChange(state => {
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

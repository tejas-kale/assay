// IPC handlers. Every handler finds its window from the sender and uses only that window's
// analysis folder and pty. Renderer arguments are checked before use.
import { ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

import { analysisSlug, createAnalysis, isoDay, listAnalyses, openAnalysis, renameAnalysis } from '../core/analyses.ts'
import { isIndex, parseRunRequest } from '../core/requests.ts'
import { addThread, closeOpen, deleteClosed, deleteOpen, editOpen, moveOpen } from '../core/threads.ts'
import type { ClosedThread } from '../core/threads.ts'
import { CHANNELS } from '../shared/ipc.ts'
import type { EditResult, NoteCreateResult, NoteReadResult, OpenResult, PlotResult, RequestResult, SetRootResult, SettingsView } from '../shared/ipc.ts'
import { analysisRoot, chooseRootPath, saveRoot } from './settings.ts'
import { listFiles, openChart, openFile, previewFile } from './browse.ts'
import { THREADS, editFile, fsPort, loadState, markOverviewRead, readPlot, readRun, readSearchContents, rootOf, writeRequest } from './files.ts'
import { addRootNote, readCitedRun, readRootNote, saveRootNote } from './notes.ts'
import { doctorView, openBlocker, recheck } from './runtime.ts'
import { clearToken, requestRestart, saveToken, updateView } from './update.ts'
import { attachAnalysis, broadcast, contextFor, hostWindow, openPicker, pushState, requestClose, retitle, showAnalysis, startPty, toggleStripSide } from './windows.ts'
import type { WindowCtx } from './windows.ts'

const MAX_WRITE = 1 << 20
const MAX_TEXT = 100_000

const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT
const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000
const invalid = (message: string): EditResult => ({ ok: false, reason: 'invalid', message })

/** The window that sent this, only for its top frame. */
function senderCtx(event: IpcMainEvent | IpcMainInvokeEvent): WindowCtx | undefined {
  if (event.senderFrame !== event.sender.mainFrame) return undefined
  return contextFor(event.sender)
}

function handle(channel: string, fn: (ctx: WindowCtx, ...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const ctx = senderCtx(event)
    if (!ctx) throw new Error('Unknown sender')
    return fn(ctx, ...args)
  })
}

function listen(channel: string, fn: (ctx: WindowCtx, ...args: unknown[]) => void) {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    const ctx = senderCtx(event)
    if (ctx) fn(ctx, ...args)
  })
}

/** Runs an edit on the window's own threads.md, then re-sends the state whatever the result. */
async function edit(ctx: WindowCtx, file: string, makeEdit: () => (text: string) => string): Promise<EditResult> {
  if (!ctx.analysis) return invalid('No analysis is open')
  const result = await editFile(ctx.analysis.path, file, makeEdit())
  await pushState(ctx)
  return result
}

const asClosed = (v: unknown): ClosedThread | undefined => {
  if (typeof v !== 'object' || v === null) return undefined
  const thread: unknown = Reflect.get(v, 'thread')
  const outcome: unknown = Reflect.get(v, 'outcome')
  if (!isText(thread)) return undefined
  if (outcome === undefined) return { thread }
  return isText(outcome) ? { thread, outcome } : undefined
}

const NO_ROOT = 'Set the analysis folder in Settings first.'

export function registerIpc() {
  handle(CHANNELS.analysesList, async () => {
    const root = await analysisRoot()
    return root ? listAnalyses(fsPort, root) : []
  })

  handle(CHANNELS.settingsGet, async (): Promise<SettingsView> => ({ root: await analysisRoot() }))
  handle(CHANNELS.settingsSetRoot, async (_ctx, input): Promise<SetRootResult> => {
    if (!isText(input)) return { ok: false, message: 'Invalid path' }
    const result = await saveRoot(input)
    if (result.ok) broadcast(CHANNELS.settingsChanged, { root: result.root } satisfies SettingsView)
    return result
  })
  handle(CHANNELS.settingsChooseRoot, () => {
    const win = hostWindow()
    return win ? chooseRootPath(win) : undefined
  })

  handle(CHANNELS.doctorGet, () => doctorView())
  handle(CHANNELS.doctorRecheck, () => recheck())

  handle(CHANNELS.updateGet, () => updateView())
  handle(CHANNELS.updateSetToken, (_ctx, input) => (isText(input) ? saveToken(input) : { ok: false, message: 'Invalid token' }))
  handle(CHANNELS.updateClearToken, () => clearToken())
  handle(CHANNELS.updateRestart, () => {
    requestRestart()
  })

  handle(CHANNELS.analysesCreate, async (ctx, title): Promise<OpenResult> => {
    if (typeof title !== 'string' || title.length > 200) return { ok: false, message: 'Invalid title' }
    const blocker = openBlocker()
    if (blocker) return { ok: false, message: blocker }
    const root = await analysisRoot()
    if (!root) return { ok: false, message: NO_ROOT }
    try {
      return attachAnalysis(ctx, await createAnalysis(fsPort, root, title, isoDay(new Date())))
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // Only a folder that listAnalyses returns for the root is accepted; one without analysis.yaml is refused with a pointer to the migration.
  handle(CHANNELS.analysesOpen, async (ctx, path): Promise<OpenResult> => {
    if (typeof path !== 'string') return { ok: false, message: 'Invalid path' }
    const blocker = openBlocker()
    if (blocker) return { ok: false, message: blocker }
    const root = await analysisRoot()
    if (!root) return { ok: false, message: NO_ROOT }
    if (!analysisSlug(path, root)) return { ok: false, message: 'Not an analysis under the root folder' }
    try {
      return attachAnalysis(ctx, await openAnalysis(fsPort, path))
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(CHANNELS.analysesRename, async (ctx, title) => {
    if (!ctx.analysis || typeof title !== 'string' || title.length > 200) return { ok: false, message: 'Invalid title' }
    try {
      ctx.analysis = await renameAnalysis(fsPort, ctx.analysis.path, title)
      retitle(ctx)
      void pushState(ctx)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(CHANNELS.ptyStart, (ctx, cols, rows) => {
    if (isSize(cols) && isSize(rows)) void startPty(ctx, cols, rows)
  })
  listen(CHANNELS.ptyWrite, (ctx, data) => {
    // While closing, nothing may reach the wrapper: a stray Ctrl-C could interrupt its import.
    if (typeof data !== 'string' || data.length > MAX_WRITE) return
    if (ctx.session?.flow.state() === 'running') ctx.session.write(data)
  })
  listen(CHANNELS.ptyResize, (ctx, cols, rows) => {
    if (isSize(cols) && isSize(rows)) ctx.session?.resize(cols, rows)
  })

  handle(CHANNELS.stateGet, ctx => (ctx.analysis ? loadState(ctx.analysis) : undefined))

  handle(CHANNELS.threadsAdd, (ctx, thread) =>
    isText(thread) ? edit(ctx, THREADS, () => text => addThread(text, thread)) : invalid('Invalid input'),
  )
  handle(CHANNELS.threadsEditOpen, (ctx, index, expected, next) =>
    isIndex(index) && isText(expected) && isText(next)
      ? edit(ctx, THREADS, () => text => editOpen(text, index, expected, next))
      : invalid('Invalid input'),
  )
  handle(CHANNELS.threadsDeleteOpen, (ctx, index, expected) =>
    isIndex(index) && isText(expected)
      ? edit(ctx, THREADS, () => text => deleteOpen(text, index, expected))
      : invalid('Invalid input'),
  )
  handle(CHANNELS.threadsCloseOpen, (ctx, index, expected, outcome) =>
    isIndex(index) && isText(expected) && isText(outcome)
      ? edit(ctx, THREADS, () => text => closeOpen(text, index, expected, outcome))
      : invalid('Invalid input'),
  )
  handle(CHANNELS.threadsDeleteClosed, (ctx, index, expected) => {
    const closed = asClosed(expected)
    return isIndex(index) && closed ? edit(ctx, THREADS, () => text => deleteClosed(text, index, closed)) : invalid('Invalid input')
  })
  handle(CHANNELS.threadsMoveOpen, (ctx, index, expected, delta) =>
    isIndex(index) && isText(expected) && (delta === 1 || delta === -1)
      ? edit(ctx, THREADS, () => text => moveOpen(text, index, expected, delta))
      : invalid('Invalid input'),
  )

  handle(CHANNELS.filesList, ctx => (ctx.analysis ? listFiles(ctx.analysis.path) : []))
  handle(CHANNELS.filesOpen, (ctx, path) => {
    if (!ctx.analysis || typeof path !== 'string' || path.length > 4096) return { ok: false, message: 'Invalid path' }
    return openFile(ctx.analysis.path, path)
  })
  handle(CHANNELS.filesPreview, (ctx, path) => {
    if (!ctx.analysis || typeof path !== 'string' || path.length > 4096) return { ok: false, message: 'Invalid path' }
    return previewFile(ctx.analysis.path, path)
  })
  handle(CHANNELS.filesOpenChart, (ctx, path, svg, colors) => {
    const color = (key: string) => {
      const value = typeof colors === 'object' && colors !== null ? Reflect.get(colors, key) : undefined
      return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined
    }
    const [bg, text] = [color('bg'), color('text')]
    if (!ctx.analysis || typeof path !== 'string' || path.length > 4096 || typeof svg !== 'string' || !bg || !text)
      return { ok: false, message: 'Invalid chart' }
    return openChart(ctx.analysis.path, path, svg, { bg, text })
  })
  handle(CHANNELS.searchContents, ctx => (ctx.analysis ? readSearchContents(ctx.analysis.path) : { notes: [], runs: [] }))
  handle(CHANNELS.runRead, (ctx, number, options) => {
    if (!ctx.analysis || !isIndex(number)) return undefined
    const option = (key: string) => (typeof options === 'object' && options !== null ? Reflect.get(options, key) : undefined)
    const table = option('table')
    const step = option('step')
    return readRun(ctx.analysis.path, number, { ...(isIndex(table) && { table }), ...(isIndex(step) && { step }) })
  })
  handle(CHANNELS.plotRead, (ctx, number, k): Promise<PlotResult> | PlotResult => {
    if (!ctx.analysis || !isIndex(number) || !isIndex(k)) return { ok: false, message: 'Invalid plot' }
    return readPlot(ctx.analysis.path, number, k)
  })
  handle(CHANNELS.runRequest, (ctx, request): Promise<RequestResult> | RequestResult => {
    if (!ctx.analysis) return { ok: false, message: 'Invalid request' }
    const parsed = parseRunRequest(request)
    return 'error' in parsed ? { ok: false, message: parsed.error } : writeRequest(ctx.analysis.path, parsed)
  })
  handle(CHANNELS.notesRead, (ctx, name): Promise<NoteReadResult> | NoteReadResult => {
    if (!ctx.analysis || typeof name !== 'string' || name.length > 255) return { ok: false, message: 'Invalid name' }
    return readRootNote(rootOf(ctx.analysis.path), name)
  })
  handle(CHANNELS.notesAdd, async (ctx, title, text): Promise<NoteCreateResult> => {
    if (!ctx.analysis || !isText(title) || !isText(text)) return { ok: false, message: 'Invalid input' }
    const result = await addRootNote(rootOf(ctx.analysis.path), ctx.analysis, title, text)
    await pushState(ctx)
    return result
  })
  handle(CHANNELS.overviewMarkRead, async (ctx, which, expected): Promise<EditResult> => {
    if (!ctx.analysis || (which !== 'analysis' && which !== 'system') || typeof expected !== 'string') return invalid('Invalid input')
    const result = await markOverviewRead(ctx.analysis.path, which, expected)
    await pushState(ctx)
    return result
  })
  handle(CHANNELS.notesSave, async (ctx, name, expected, text): Promise<EditResult> => {
    if (!ctx.analysis || typeof name !== 'string' || typeof expected !== 'string' || typeof text !== 'string') return invalid('Invalid input')
    const result = await saveRootNote(rootOf(ctx.analysis.path), name, expected, text)
    await pushState(ctx)
    return result
  })
  handle(CHANNELS.notesRun, (ctx, analysis, number) => {
    if (!ctx.analysis || typeof analysis !== 'string' || analysis.length > 200 || !isIndex(number)) return undefined
    return readCitedRun(rootOf(ctx.analysis.path), analysis, number)
  })

  handle(CHANNELS.windowNew, () => {
    openPicker()
  })
  handle(CHANNELS.windowClose, ctx => {
    requestClose(ctx)
  })
  // The strip and the palette's Show analysis N. The strip is no analysis's view, so this skips senderCtx.
  ipcMain.handle(CHANNELS.analysisShow, (event, n: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 9) showAnalysis(n)
  })
  handle(CHANNELS.stripSide, () => {
    toggleStripSide()
  })
}

// IPC handlers. Every handler finds its window from the sender and uses only that window's
// analysis folder and pty. Renderer arguments are checked before use.
import { ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

import { createAnalysis, listAnalyses } from '../core/analyses.ts'
import { addFact, deleteFact, editFact } from '../core/facts.ts'
import type { LabelOf } from '../core/facts.ts'
import { isIndex, parseRunRequest } from '../core/requests.ts'
import { citedLabel } from '../core/runs.ts'
import { addThread, closeOpen, deleteClosed, deleteOpen, editOpen, moveOpen } from '../core/threads.ts'
import type { ClosedThread } from '../core/threads.ts'
import { CHANNELS } from '../shared/ipc.ts'
import type { EditResult, NoteFileResult, OpenResult, PlotResult, RequestResult, SetRootResult, SettingsView } from '../shared/ipc.ts'
import { analysisRoot, chooseRootPath, saveRoot } from './settings.ts'
import { listFiles, openFile } from './browse.ts'
import { NOTES, THREADS, editFile, fsPort, loadState, readNoteFile, readPlot, readRun, readRuns, writeRequest } from './files.ts'
import { attachAnalysis, broadcast, contextFor, createWindow, pushState, requestClose, startPty } from './windows.ts'
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

/** Runs an edit on the window's own notes.md or threads.md, then re-sends the state whatever the result. */
async function edit(
  ctx: WindowCtx,
  file: string,
  makeEdit: (labelOf: LabelOf) => (text: string) => string,
): Promise<EditResult> {
  if (!ctx.analysis) return invalid('No analysis is open')
  const labelOf = file === NOTES ? citedLabel(await readRuns(ctx.analysis.path)) : () => 'unverified' as const
  const result = await editFile(ctx.analysis.path, file, makeEdit(labelOf))
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
  handle(CHANNELS.settingsChooseRoot, ctx => chooseRootPath(ctx.win))

  handle(CHANNELS.analysesCreate, async (ctx, name): Promise<OpenResult> => {
    if (typeof name !== 'string' || name.length > 200) return { ok: false, message: 'Invalid name' }
    const root = await analysisRoot()
    if (!root) return { ok: false, message: NO_ROOT }
    try {
      const path = await createAnalysis(fsPort, root, name)
      return attachAnalysis(ctx, { name, path })
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // Only a folder that listAnalyses returns for the root is accepted.
  handle(CHANNELS.analysesOpen, async (ctx, path): Promise<OpenResult> => {
    if (typeof path !== 'string') return { ok: false, message: 'Invalid path' }
    const root = await analysisRoot()
    if (!root) return { ok: false, message: NO_ROOT }
    const found = (await listAnalyses(fsPort, root)).find(a => a.path === path)
    if (!found) return { ok: false, message: 'Not an analysis under the root folder' }
    return attachAnalysis(ctx, { name: found.name, path: found.path })
  })

  handle(CHANNELS.ptyStart, (ctx, cols, rows) => {
    if (isSize(cols) && isSize(rows)) startPty(ctx, cols, rows)
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

  handle(CHANNELS.factsAdd, (ctx, input) =>
    isText(input) ? edit(ctx, NOTES, labelOf => text => addFact(text, input, labelOf)) : invalid('Invalid input'),
  )
  handle(CHANNELS.factsEdit, (ctx, index, line, input) =>
    isIndex(index) && isText(line) && isText(input)
      ? edit(ctx, NOTES, labelOf => text => editFact(text, index, line, input, labelOf))
      : invalid('Invalid input'),
  )
  handle(CHANNELS.factsDelete, (ctx, index, line) =>
    isIndex(index) && isText(line) ? edit(ctx, NOTES, () => text => deleteFact(text, index, line)) : invalid('Invalid input'),
  )

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
  handle(CHANNELS.runRead, (ctx, number, options) => {
    if (!ctx.analysis || !isIndex(number)) return undefined
    const table = typeof options === 'object' && options !== null ? Reflect.get(options, 'table') : undefined
    return readRun(ctx.analysis.path, number, isIndex(table) ? { table } : {})
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
  handle(CHANNELS.noteFileRead, (ctx, path): Promise<NoteFileResult> | NoteFileResult => {
    if (!ctx.analysis || typeof path !== 'string') return { ok: false, message: 'Invalid path' }
    return readNoteFile(ctx.analysis.path, path)
  })

  handle(CHANNELS.windowNew, () => {
    createWindow()
  })
  handle(CHANNELS.windowClose, ctx => {
    requestClose(ctx)
  })
}

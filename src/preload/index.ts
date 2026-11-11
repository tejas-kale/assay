// Exposes AppApi as window.app. Each method wraps one channel from shared/ipc.ts; ipcRenderer
// itself is never exposed. Runs under sandbox: true, so the only runtime import is 'electron'.
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import { CHANNELS } from '../shared/ipc.ts'
import type { AppApi, Unsubscribe } from '../shared/ipc.ts'

/** Subscribes to a main -> renderer event. The IpcRendererEvent is dropped, and the returned function removes this exact listener. */
function subscribe(channel: string, cb: (value: never) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, value: unknown) => {
    // The payload's type is the AppApi callback's own (shared/ipc.ts); main sends what that type says.
    cb(value as never)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * Calls a main handler. Its answer is typed by the AppApi member that returns it (shared/ipc.ts), which is the one
 * contract both sides follow; `never` lets each member's own return type stand.
 */
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<never>

/** Sends to main without waiting for an answer. */
const send = (channel: string, ...args: unknown[]) => {
  ipcRenderer.send(channel, ...args)
}

const api: AppApi = {
  analyses: {
    list: () => invoke(CHANNELS.analysesList),
    create: title => invoke(CHANNELS.analysesCreate, title),
    rename: title => invoke(CHANNELS.analysesRename, title),
    open: path => invoke(CHANNELS.analysesOpen, path),
  },
  pty: {
    start: (cols, rows) => invoke(CHANNELS.ptyStart, cols, rows),
    write: data => {
      send(CHANNELS.ptyWrite, data)
    },
    resize: (cols, rows) => {
      send(CHANNELS.ptyResize, cols, rows)
    },
    onData: cb => subscribe(CHANNELS.ptyData, cb),
    onExit: cb => subscribe(CHANNELS.ptyExit, cb),
  },
  state: {
    get: () => invoke(CHANNELS.stateGet),
    onChange: cb => subscribe(CHANNELS.stateChanged, cb),
  },
  threads: {
    add: text => invoke(CHANNELS.threadsAdd, text),
    editOpen: (index, expected, next) => invoke(CHANNELS.threadsEditOpen, index, expected, next),
    deleteOpen: (index, expected) => invoke(CHANNELS.threadsDeleteOpen, index, expected),
    closeOpen: (index, expected, outcome) => invoke(CHANNELS.threadsCloseOpen, index, expected, outcome),
    deleteClosed: (index, expected) => invoke(CHANNELS.threadsDeleteClosed, index, expected),
    moveOpen: (index, expected, delta) => invoke(CHANNELS.threadsMoveOpen, index, expected, delta),
  },
  overview: {
    markRead: (which, expectedText) => invoke(CHANNELS.overviewMarkRead, which, expectedText),
  },
  notes: {
    read: name => invoke(CHANNELS.notesRead, name),
    add: (title, text) => invoke(CHANNELS.notesAdd, title, text),
    save: (name, expectedText, text) => invoke(CHANNELS.notesSave, name, expectedText, text),
    readRun: (analysis, number) => invoke(CHANNELS.notesRun, analysis, number),
  },
  readRun: (number, options) => invoke(CHANNELS.runRead, number, options),
  readPlot: (number, k) => invoke(CHANNELS.plotRead, number, k),
  runs: {
    request: request => invoke(CHANNELS.runRequest, request),
    onReply: cb => subscribe(CHANNELS.runReply, cb),
  },
  files: {
    list: () => invoke(CHANNELS.filesList),
    open: path => invoke(CHANNELS.filesOpen, path),
    preview: path => invoke(CHANNELS.filesPreview, path),
    openChart: (path, svg, colors) => invoke(CHANNELS.filesOpenChart, path, svg, colors),
  },
  searchContents: () => invoke(CHANNELS.searchContents),
  onCommand: cb => subscribe(CHANNELS.command, cb),
  newWindow: () => invoke(CHANNELS.windowNew),
  closeWindow: () => invoke(CHANNELS.windowClose),
  showAnalysis: n => invoke(CHANNELS.analysisShow, n),
  onStripEntries: cb => subscribe(CHANNELS.stripEntries, cb),
  toggleStripSide: () => invoke(CHANNELS.stripSide),
  settings: {
    get: () => invoke(CHANNELS.settingsGet),
    setRoot: input => invoke(CHANNELS.settingsSetRoot, input),
    chooseRoot: () => invoke(CHANNELS.settingsChooseRoot),
    setTabs: tabs => invoke(CHANNELS.settingsSetTabs, tabs),
    setStrip: strip => invoke(CHANNELS.settingsSetStrip, strip),
    onChange: cb => subscribe(CHANNELS.settingsChanged, cb),
  },
  doctor: {
    get: () => invoke(CHANNELS.doctorGet),
    recheck: () => invoke(CHANNELS.doctorRecheck),
    onChange: cb => subscribe(CHANNELS.doctorChanged, cb),
  },
  update: {
    get: () => invoke(CHANNELS.updateGet),
    setToken: input => invoke(CHANNELS.updateSetToken, input),
    forgetToken: () => invoke(CHANNELS.updateForgetToken),
    restart: () => invoke(CHANNELS.updateRestart),
    onChange: cb => subscribe(CHANNELS.updateChanged, cb),
  },
  onHints: cb => subscribe(CHANNELS.hints, cb),
  onCloseState: cb => subscribe(CHANNELS.closeState, cb),
}

contextBridge.exposeInMainWorld('app', api)

// Exposes AppApi as window.app. Each method wraps one channel from shared/ipc.ts; ipcRenderer
// itself is never exposed. Runs under sandbox: true, so the only runtime import is 'electron'.
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import { CHANNELS } from '../shared/ipc.ts'
import type { AppApi, Unsubscribe } from '../shared/ipc.ts'

/** Subscribes to a main -> renderer event. The IpcRendererEvent is dropped, and the returned function removes this exact listener. */
function subscribe<T>(channel: string, cb: (value: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, value: T) => cb(value)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: AppApi = {
  analyses: {
    list: () => invoke(CHANNELS.analysesList),
    create: name => invoke(CHANNELS.analysesCreate, name),
    open: path => invoke(CHANNELS.analysesOpen, path),
  },
  pty: {
    start: (cols, rows) => invoke(CHANNELS.ptyStart, cols, rows),
    write: data => ipcRenderer.send(CHANNELS.ptyWrite, data),
    resize: (cols, rows) => ipcRenderer.send(CHANNELS.ptyResize, cols, rows),
    onData: cb => subscribe(CHANNELS.ptyData, cb),
    onExit: cb => subscribe(CHANNELS.ptyExit, cb),
  },
  state: {
    get: () => invoke(CHANNELS.stateGet),
    onChange: cb => subscribe(CHANNELS.stateChanged, cb),
  },
  facts: {
    add: input => invoke(CHANNELS.factsAdd, input),
    edit: (index, expectedLine, input) => invoke(CHANNELS.factsEdit, index, expectedLine, input),
    delete: (index, expectedLine) => invoke(CHANNELS.factsDelete, index, expectedLine),
  },
  threads: {
    add: text => invoke(CHANNELS.threadsAdd, text),
    editOpen: (index, expected, next) => invoke(CHANNELS.threadsEditOpen, index, expected, next),
    deleteOpen: (index, expected) => invoke(CHANNELS.threadsDeleteOpen, index, expected),
    closeOpen: (index, expected, outcome) => invoke(CHANNELS.threadsCloseOpen, index, expected, outcome),
    deleteClosed: (index, expected) => invoke(CHANNELS.threadsDeleteClosed, index, expected),
    moveOpen: (index, expected, delta) => invoke(CHANNELS.threadsMoveOpen, index, expected, delta),
  },
  readNoteFile: path => invoke(CHANNELS.noteFileRead, path),
  readRun: number => invoke(CHANNELS.runRead, number),
  files: {
    list: () => invoke(CHANNELS.filesList),
    open: path => invoke(CHANNELS.filesOpen, path),
  },
  onCommand: cb => subscribe(CHANNELS.command, cb),
  newWindow: () => invoke(CHANNELS.windowNew),
  closeWindow: () => invoke(CHANNELS.windowClose),
  settings: {
    get: () => invoke(CHANNELS.settingsGet),
    setRoot: input => invoke(CHANNELS.settingsSetRoot, input),
    chooseRoot: () => invoke(CHANNELS.settingsChooseRoot),
    onChange: cb => subscribe(CHANNELS.settingsChanged, cb),
  },
  onHints: cb => subscribe(CHANNELS.hints, cb),
  onCloseState: cb => subscribe(CHANNELS.closeState, cb),
}

contextBridge.exposeInMainWorld('app', api)

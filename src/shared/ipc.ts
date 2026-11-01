// The only contract between main, preload and renderer. Types and channel names only: no
// electron import, so it is safe to import from any of the three.
//
// Preload exposes `AppApi` as `window.app`; each method wraps one channel below
// (`invoke` for requests, `on` for events). Main owns all files: the renderer never
// reads or writes a path itself.

import type { Analysis } from '../core/analyses.ts'
import type { CommandId } from '../core/keymap.ts'
import type { Fact } from '../core/facts.ts'
import type { CloseState } from '../core/session.ts'
import type { ClosedThread, Threads } from '../core/threads.ts'

export type { Analysis, ClosedThread, CloseState, CommandId, Fact, Threads }

/** Call to stop listening. */
export type Unsubscribe = () => void

/** Result of an edit to notes.md or threads.md. Main re-sends the state on every non-ok result too. */
export type EditResult =
  | { ok: true }
  /** `stale`: the item changed on disk; message is "Changed on disk, reloaded". `invalid`: empty input, or an edit of a file note. */
  | { ok: false; reason: 'stale' | 'invalid'; message: string }

/** What the Notes and Threads tabs show. Re-derived by main from the files after each poll hit or edit. */
export type AnalysisState = {
  /** The analysis this window holds. */
  analysis: { name: string; path: string }
  facts: Fact[]
  threads: Threads
}

export type OpenResult =
  /** This window is now the workspace for `path`. */
  | { ok: true; outcome: 'opened'; path: string }
  /** The analysis is open in another window, which main focused; this window stays on the picker. */
  | { ok: true; outcome: 'focused-other-window'; path: string }
  | { ok: false; message: string }

export type NoteFileResult = { ok: true; text: string } | { ok: false; message: string }

export type PtyExit = { exitCode: number; signal?: number }

export type AppApi = {
  analyses: {
    /** Newest first. Works in any window; call it on mount, then filter locally with fuzzyRank. */
    list(): Promise<Analysis[]>
    /** Creates `analyses/<name>/.analysis` (invalid name -> ok false) and opens it. */
    create(name: string): Promise<OpenResult>
    /** Opens by `Analysis.path`. */
    open(path: string): Promise<OpenResult>
  }

  pty: {
    /**
     * Call once after the terminal is mounted and fitted. Main spawns the wrapper at that size
     * (so no output is lost before the renderer listens). Does nothing if already started.
     */
    start(cols: number, rows: number): Promise<void>
    write(data: string): void
    resize(cols: number, rows: number): void
    onData(cb: (data: string) => void): Unsubscribe
    /** The pty ended by itself or after a close. Show "Session ended (exit N)" unless closing. */
    onExit(cb: (exit: PtyExit) => void): Unsubscribe
  }

  state: {
    /** Current state, or undefined while this window is still on the picker. */
    get(): Promise<AnalysisState | undefined>
    /** Fired after every poll hit and every edit. Replace what you hold; keep no copy across reloads. */
    onChange(cb: (state: AnalysisState) => void): Unsubscribe
  }

  /**
   * Edits. `expected` args are what the renderer last saw for that item (`Fact.line`, the thread text,
   * the `ClosedThread`); main applies the core function to freshly read text, so a stale view gets
   * `{ ok: false, reason: 'stale' }` and a state push instead of an overwrite.
   * Fact input is raw user text; a trailing `[q 12]` is read, the label is derived (see core/facts.ts).
   */
  facts: {
    add(input: string): Promise<EditResult>
    edit(index: number, expectedLine: string, input: string): Promise<EditResult>
    delete(index: number, expectedLine: string): Promise<EditResult>
  }
  threads: {
    add(text: string): Promise<EditResult>
    editOpen(index: number, expected: string, next: string): Promise<EditResult>
    deleteOpen(index: number, expected: string): Promise<EditResult>
    closeOpen(index: number, expected: string, outcome: string): Promise<EditResult>
    deleteClosed(index: number, expected: ClosedThread): Promise<EditResult>
    /** delta -1 moves up, +1 down. */
    moveOpen(index: number, expected: string, delta: number): Promise<EditResult>
  }

  /** Reads a linked note file, on request. `path` is `Fact.file.path`; main resolves it against the analysis folder. */
  readNoteFile(path: string): Promise<NoteFileResult>

  /**
   * A shortcut claimed in main's before-input-event (see core/keymap.ts). Main handles
   * `window.new` and `window.close` itself and never sends them here; the palette calls
   * `newWindow()` and `closeWindow()` for those two.
   */
  onCommand(cb: (id: CommandId) => void): Unsubscribe
  /** Opens a new picker window (Cmd+N). */
  newWindow(): Promise<void>
  /** Same path as the window's close button: starts the graceful close while a session runs. */
  closeWindow(): Promise<void>

  /**
   * Graceful-close state. 'closing' -> show the "Closing: waiting for the session to finish" banner
   * with the terminal still visible; 'exited' follows and main then closes the window. Main
   * shows the Keep waiting / Force quit dialog itself.
   */
  onCloseState(cb: (state: CloseState) => void): Unsubscribe
}

/** Channel names. `invoke` channels reply with the result type of the matching `AppApi` method. */
export const CHANNELS = {
  // renderer -> main, request/reply (ipcRenderer.invoke / ipcMain.handle)
  analysesList: 'analyses:list',
  analysesCreate: 'analyses:create',
  analysesOpen: 'analyses:open',
  ptyStart: 'pty:start',
  stateGet: 'state:get',
  factsAdd: 'facts:add',
  factsEdit: 'facts:edit',
  factsDelete: 'facts:delete',
  threadsAdd: 'threads:add',
  threadsEditOpen: 'threads:editOpen',
  threadsDeleteOpen: 'threads:deleteOpen',
  threadsCloseOpen: 'threads:closeOpen',
  threadsDeleteClosed: 'threads:deleteClosed',
  threadsMoveOpen: 'threads:moveOpen',
  noteFileRead: 'noteFile:read',
  windowNew: 'window:new',
  windowClose: 'window:close',
  // renderer -> main, fire and forget (ipcRenderer.send / ipcMain.on)
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  // main -> renderer events (webContents.send / ipcRenderer.on)
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  stateChanged: 'state:changed',
  command: 'command',
  closeState: 'close:state',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

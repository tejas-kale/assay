// The only contract between main, preload and renderer. Types and channel names only: no
// electron import, so it is safe to import from any of the three.
//
// Preload exposes `AppApi` as `window.app`; each method wraps one channel below
// (`invoke` for requests, `on` for events). Main owns all files: the renderer never
// reads or writes a path itself.

import type { Analysis } from '../core/analyses.ts'
import type { CommandId } from '../core/keymap.ts'
import type { Fact } from '../core/facts.ts'
import type { FileEntry } from '../core/files.ts'
import type { NoteFile } from '../core/noteFiles.ts'
import type { CloseState } from '../core/session.ts'
import type { Reply, RunRequest } from '../core/requests.ts'
import type { Engine, KernelState, Run, RunResult, RunStatus, Table } from '../core/runs.ts'
import type { SearchContents } from '../core/search.ts'
import type { ClosedThread, Threads } from '../core/threads.ts'
import type { TrustReview } from '../core/trust.ts'

export type { Analysis, ClosedThread, CloseState, CommandId, Engine, Fact, FileEntry, KernelState, NoteFile, Reply, Run, RunRequest, RunResult, RunStatus, SearchContents, Table, Threads, TrustReview }

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
  analysis: { name: string; title: string; path: string }
  facts: Fact[]
  threads: Threads
  /** The runs in `queries/`, oldest first. */
  runs: Run[]
  /** Which run is running and which failed, from the mod. */
  runStatus: RunStatus
  /** The note files in `notes/`, in number order. */
  noteFiles: NoteFile[]
  /** The latest trust review from `.assay/trust/`, for the Trust tab. */
  trust?: TrustReview
}

/**
 * One run's code and saved result, for the Code and Data tabs. A Python run also carries its parsed `.json`
 * (`result`) and one table: `table` is table `tableIndex` (1-based) of `run.tables`.
 */
export type RunView = { run: Run; code?: string; table?: Table; tableIndex?: number; result?: RunResult; error?: string }


/** A plot image as a data URL, or why it could not be read. */
export type PlotResult = { ok: true; dataUrl: string } | { ok: false; message: string }

/** `ok`: the request file is written and `id` will come back in a reply. */
export type RequestResult = { ok: true; id: string } | { ok: false; message: string }

export type OpenResult =
  /** This window is now the workspace for `path`. */
  | { ok: true; outcome: 'opened'; path: string }
  /** The analysis is open in another window, which main focused; this window stays on the picker. */
  | { ok: true; outcome: 'focused-other-window'; path: string }
  | { ok: false; message: string }

/** How a file opened: in Neovim in a new Ghostty window, as a chart page in the browser (a Mermaid file), as an image to preview, or in its default app. */
export type OpenFileResult =
  | { ok: true; how: 'nvim' | 'browser' | 'default' }
  | { ok: true; how: 'image'; dataUrl: string }
  | { ok: false; message: string }

/** A file's content for a preview: text (cut at a size limit), an image, or a binary file it cannot show. */
export type PreviewResult =
  | { ok: true; kind: 'text'; text: string; truncated: boolean }
  | { ok: true; kind: 'image'; dataUrl: string }
  | { ok: true; kind: 'binary'; size: number }
  | { ok: false; message: string }

export type NoteFileResult = { ok: true; text: string } | { ok: false; message: string }

/** `name` is the new file's name inside `notes/`. */
export type NoteFileCreateResult = { ok: true; name: string } | { ok: false; message: string }

export type SettingsView = { root: string | undefined }
export type SetRootResult = { ok: true; root: string } | { ok: false; message: string }

export type PtyExit = { exitCode: number; signal?: number }

export type AppApi = {
  analyses: {
    /** Newest first. Works in any window; call it on mount, then filter locally with fuzzyRank. */
    list(): Promise<Analysis[]>
    /** Creates `analyses/<slug>/analysis.yaml` from a typed title (a title with no letters or digits -> ok false) and opens it. */
    create(title: string): Promise<OpenResult>
    /** Edits the open analysis's title; its folder stays. The workspace state follows. */
    rename(title: string): Promise<{ ok: true } | { ok: false; message: string }>
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
    moveOpen(index: number, expected: string, delta: 1 | -1): Promise<EditResult>
  }

  files: {
    /** Every file in the analysis, newest first; tooling folders (.git, .venv, ...) left out. */
    list(): Promise<FileEntry[]>
    /** Opens `FileEntry.path`: text in Neovim, images as a preview, the rest in their default app. */
    open(path: string): Promise<OpenFileResult>
    /** `FileEntry.path` (or any path inside the analysis) for a preview; nothing is opened. */
    preview(path: string): Promise<PreviewResult>
    /** Opens a Mermaid file's chart, drawn here as `svg`, as a page in the default browser. `colors` style the page. */
    openChart(path: string, svg: string, colors: { bg: string; text: string }): Promise<OpenFileResult>
  }

  /** The text of every note file and every run's code, for universal search to match bodies. */
  searchContents(): Promise<SearchContents>

  /** One run's code and result by number; undefined when the run is gone. `table` picks table K (1-based) of a Python run. */
  readRun(number: number, options?: { table?: number }): Promise<RunView | undefined>
  /** Plot K (1-based) of a Python run, as a data URL. */
  readPlot(number: number, k: number): Promise<PlotResult>

  runs: {
    /** Writes `.assay/requests/<id>.json` for the mod to run. */
    request(request: RunRequest): Promise<RequestResult>
    /** The mod's answer to a request; also fired for ids this window did not send. Main has deleted the file. */
    onReply(cb: (reply: Reply) => void): Unsubscribe
  }

  /** Reads a linked note file, on request. `path` is `Fact.file.path`; main resolves it against the analysis folder. */
  readNoteFile(path: string): Promise<NoteFileResult>

  /** Note files in `notes/`, by `NoteFile.name`. Main re-sends the state after create, save and delete. */
  noteFiles: {
    read(name: string): Promise<NoteFileResult>
    /** Number and slug are derived from the title; a slug already used gets -2, -3. Never overwrites. */
    create(title: string): Promise<NoteFileCreateResult>
    /** Writes `text` if the file still holds `expectedText`, else `stale` (message "Changed on disk, reloaded"). */
    save(name: string, expectedText: string, text: string): Promise<EditResult>
    delete(name: string, expectedText: string): Promise<EditResult>
  }

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

  settings: {
    get(): Promise<SettingsView>
    /** Saves the folder holding `analyses/`. It must already exist. */
    setRoot(input: string): Promise<SetRootResult>
    /** The native folder chooser; undefined when cancelled. Saves nothing. */
    chooseRoot(): Promise<string | undefined>
    /** Fired in every window after a save. */
    onChange(cb: (settings: SettingsView) => void): Unsubscribe
  }

  /** True while left Cmd is long-pressed: show the navigation hints. */
  onHints(cb: (visible: boolean) => void): Unsubscribe

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
  analysesRename: 'analyses:rename',
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
  noteFilesRead: 'noteFiles:read',
  noteFilesCreate: 'noteFiles:create',
  noteFilesSave: 'noteFiles:save',
  noteFilesDelete: 'noteFiles:delete',
  runRead: 'run:read',
  plotRead: 'plot:read',
  runRequest: 'run:request',
  filesList: 'files:list',
  filesOpen: 'files:open',
  filesPreview: 'files:preview',
  filesOpenChart: 'files:openChart',
  searchContents: 'search:contents',
  windowNew: 'window:new',
  windowClose: 'window:close',
  settingsGet: 'settings:get',
  settingsSetRoot: 'settings:setRoot',
  settingsChooseRoot: 'settings:chooseRoot',
  // renderer -> main, fire and forget (ipcRenderer.send / ipcMain.on)
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  // main -> renderer events (webContents.send / ipcRenderer.on)
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  stateChanged: 'state:changed',
  runReply: 'run:reply',
  command: 'command',
  closeState: 'close:state',
  settingsChanged: 'settings:changed',
  hints: 'hints',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

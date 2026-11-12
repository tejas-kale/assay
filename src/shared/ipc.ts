// The only contract between main, preload and renderer. Types and channel names only: no
// electron import, so it is safe to import from any of the three.
//
// Preload exposes `AppApi` as `window.app`; each method wraps one channel below
// (`invoke` for requests, `on` for events). Main owns all files: the renderer never
// reads or writes a path itself.

import type { Analysis, AnalysisRef } from '../core/analyses.ts'
import type { CommandId } from '../core/keymap.ts'
import type { HoldKind } from '../core/cmdHold.ts'
import type { StripEntry, StripPrefs, StripSide } from '../core/strip.ts'
import type { TabPrefs } from '../core/tabs.ts'
import type { FileEntry } from '../core/files.ts'
import type { CitationLabel } from '../core/citationLabels.ts'
import type { NoteLists, RootNote } from '../core/rootNotes.ts'
import type { CloseState } from '../core/session.ts'
import type { Reply, RunRequest } from '../core/requests.ts'
import type { LineageFile } from '../core/lineage.ts'
import type { StepsFile } from '../core/steps.ts'
import type { Engine, KernelState, Run, RunResult, RunStatus, Table } from '../core/runs.ts'
import type { SearchContents } from '../core/search.ts'
import type { ClosedThread, Threads } from '../core/threads.ts'
import type { TrustReview } from '../core/trust.ts'
import type { TrustAdoptResult, TrustUnadoptedResult } from '../core/trustAdopt.ts'
import type { TrustApproveInput, TrustApproveResult, TrustFilesResult } from '../core/trustApprove.ts'
import type { Proposal } from '../core/requests.ts'
import type { OverviewState, OverviewWhich } from '../core/overview.ts'
import type { Check } from '../core/doctor.ts'
import type { UpdateState } from '../core/update.ts'

export type { TrustAdoptResult, TrustApproveInput, TrustApproveResult, TrustFilesResult, TrustUnadoptedResult }
export type { CitationLabel, Analysis, AnalysisRef, ClosedThread, CloseState, CommandId, Engine, FileEntry, KernelState, NoteLists, Reply, RootNote, Run, RunRequest, RunResult, RunStatus, SearchContents, Table, Threads, TrustReview, OverviewState, OverviewWhich }

/** Call to stop listening. */
export type Unsubscribe = () => void

/** Result of an edit to threads.md or a note. Main re-sends the state on every non-ok result too. */
export type EditResult =
  | { ok: true }
  /** `stale`: the item changed on disk; message is "Changed on disk, reloaded". `invalid`: empty input, or an edit of a file note. */
  | { ok: false; reason: 'stale' | 'invalid'; message: string }

/** What the Notes and Threads tabs show. Re-derived by main from the files after each poll hit or edit. */
export type AnalysisState = {
  /** The analysis this window holds. */
  analysis: AnalysisRef
  threads: Threads
  /** The runs in `queries/`, oldest first. */
  runs: Run[]
  /** Which run is running and which failed, from the mod. */
  runStatus: RunStatus
  /** Every note in `<root>/notes`, by ID. The Notes tab groups them by `noteLists`; the reader resolves links in them. */
  rootNotes: RootNote[]
  /** The `notes:` lists of this analysis's analysis.yaml. */
  noteLists: NoteLists
  /** The latest trust review from `.assay/trust/`, for the Trust tab. */
  trust?: TrustReview
  /** The analysis overview, its system overview and their read baselines, for the Overview tab (specs/slices/slice-10.md). */
  overview: OverviewState
}

/**
 * One run's code and saved result, for the Code and Data tabs. A Python run also carries its parsed `.json`
 * (`result`) and one table: `table` is table `tableIndex` (1-based) of `run.tables`.
 */
export type RunView = {
  run: Run
  code?: string
  /** A run with includes: its expanded SQL, which ran (specs/slices/slice-10.md). */
  expanded?: string
  /** Claude's run's warnings: SQL rules and retyped trusted logic (specs/slices/slice-10.md). */
  notices?: { rules: string[]; retype: string[] }
  table?: Table
  tableIndex?: number
  result?: RunResult
  lineage?: LineageFile
  steps?: StepsFile
  stepTable?: Table
  error?: string
}


/** A plot image as a data URL, or why it could not be read. */
export type PlotResult = { ok: true; dataUrl: string } | { ok: false; message: string }

/** `ok`: the request file is written and `id` will come back in a reply. */
export type RequestResult = { ok: true; id: string } | { ok: false; message: string }


export type StripView = { side: StripSide; entries: StripEntry[] }

export type OpenResult =
  /** This view is now the workspace for `path`. */
  | { ok: true; outcome: 'opened'; path: string }
  /** The analysis is already open in another view, which main showed; this picker view is closed. */
  | { ok: true; outcome: 'focused-other-window'; path: string }
  | { ok: false; message: string }

/** How a file opened: in Neovim in a new Ghostty window, as a chart page in the browser (a Mermaid file), as an image to preview, or in its default app. */
export type OpenFileResult =
  | { ok: true; how: 'nvim' | 'browser' | 'default' | 'finder' }
  | { ok: true; how: 'image'; dataUrl: string }
  | { ok: false; message: string }

/** A file's content for a preview: text (cut at a size limit), an image, or a binary file it cannot show. */
export type PreviewResult =
  | { ok: true; kind: 'text'; text: string; truncated: boolean }
  | { ok: true; kind: 'image'; dataUrl: string }
  | { ok: true; kind: 'binary'; size: number }
  | { ok: false; message: string }

/** A note's text and the label of each citation in it (key `<analysis> q <N>`), derived when read. */
export type NoteReadResult = { ok: true; text: string; labels: Record<string, CitationLabel> } | { ok: false; message: string }

/** `name` is the new file's name inside `<root>/notes/`. */
export type NoteCreateResult = { ok: true; name: string } | { ok: false; message: string }

/** The app's settings as the renderer sees them: the folder, and the tab and strip choices (specs/slices/slice-11.md, 11e). */
export type SettingsView = { root: string | undefined; tabs: TabPrefs; strip: StripPrefs }
/** The Doctor in Settings: this version, what it is preparing, and the checks of the tools and the venv. */
export type DoctorView = { version: string; checks: Check[]; isChecking: boolean; preparing?: string; error?: string }

/**
 * Settings > Updates and the ready banner: the updater's state. The token itself never leaves main; `hasToken` says
 * whether one is kept. `isPackaged` is false under `npm run dev`, where the updater never runs.
 */
export type UpdateView = UpdateState & { hasToken: boolean; isPackaged: boolean }

export type SetTokenResult = { ok: true } | { ok: false; message: string }

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
   * Edits. `expected` args are what the renderer last saw for that item (the thread text, the
   * `ClosedThread`); main applies the core function to freshly read text, so a stale view gets
   * `{ ok: false, reason: 'stale' }` and a state push instead of an overwrite.
   */
  threads: {
    add(text: string): Promise<EditResult>
    editOpen(index: number, expected: string, next: string): Promise<EditResult>
    deleteOpen(index: number, expected: string): Promise<EditResult>
    closeOpen(index: number, expected: string, outcome: string): Promise<EditResult>
    deleteClosed(index: number, expected: ClosedThread): Promise<EditResult>
    /** delta -1 moves up, +1 down. */
    moveOpen(index: number, expected: string, delta: 1 | -1): Promise<EditResult>
  }

  overview: {
    /** Marks the shown overview read: its text becomes the diff's baseline, if the file still holds `expectedText`. */
    markRead(which: OverviewWhich, expectedText: string): Promise<EditResult>
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

  /** The text of every root note and every run's code, for universal search to match bodies. */
  searchContents(): Promise<SearchContents>

  /** One run's code and result by number; undefined when the run is gone. `table` picks table K (1-based) of a Python run. */
  readRun(number: number, options?: { table?: number; step?: number }): Promise<RunView | undefined>
  /** Plot K (1-based) of a Python run, as a data URL. */
  readPlot(number: number, k: number): Promise<PlotResult>

  runs: {
    /** Writes `.assay/requests/<id>.json` for the mod to run. */
    request(request: RunRequest): Promise<RequestResult>
    /** The mod's answer to a request; also fired for ids this window did not send. Main has deleted the file. */
    onReply(cb: (reply: Reply) => void): Unsubscribe
  }

  /**
   * The Trust tab's two calls (specs/trust-ledger.md). Only main approves: Claude's side cannot reach these, and a
   * request file cannot approve.
   */
  trust: {
    /** The proposal's own files in the analysis's draft folder as main reads them now, each with its sha256. Nothing else is shown as the thing to approve. */
    files(proposal: { name: string; kind: Proposal['kind'] }): Promise<TrustFilesResult>
    /**
     * Trust: main re-reads the draft and refuses when its files or any hash differ from `hashes` (what was shown),
     * then copies those bytes into the root's trusted/ or dictionaries/, commits them, records them in the ledger and
     * removes the draft files that still match.
     */
    approve(input: TrustApproveInput): Promise<TrustApproveResult>
    /** The groups in the root's trusted/ and dictionaries/ the ledger does not cover, as main reads them now: text and sha256 of each file. */
    unadopted(): Promise<TrustUnadoptedResult>
    /** Adopt one group: main re-reads it, refuses when any file or hash differs from `hashes` (what was shown) or a file is a link, then records the hashes in the ledger. Nothing is copied or committed. */
    adopt(input: TrustApproveInput): Promise<TrustAdoptResult>
  }

  /** Root notes in `<root>/notes`, by `RootNote.name`. Main re-sends the state after add and save. */
  notes: {
    /** The note's text and its citations' labels, derived now. */
    read(name: string): Promise<NoteReadResult>
    /**
     * Writes a new note for the open analysis and lists it under `written`. The ID is the time now and the file name
     * follows from the title; bare `[q 12]` citations get this analysis's slug. Never overwrites.
     */
    add(title: string, text: string): Promise<NoteCreateResult>
    /** Writes `text` if the file still holds `expectedText`, else `stale` (message "Changed on disk, reloaded"). */
    save(name: string, expectedText: string, text: string): Promise<EditResult>
    /** One run of another analysis under the root, for a citation's preview; undefined when it is gone. */
    readRun(analysis: string, number: number): Promise<RunView | undefined>
  }

  /**
   * A shortcut claimed in main's before-input-event (see core/keymap.ts). Main handles `analysis.new`,
   * `analysis.close` and `analysis.1` to `analysis.9` itself and never sends them here; the palette calls
   * `newWindow()`, `closeWindow()` and `showAnalysis(n)` for those.
   */
  onCommand(cb: (id: CommandId) => void): Unsubscribe
  /** Shows the picker to open another analysis in this window (Cmd+N). */
  newWindow(): Promise<void>
  /** Closes this analysis (Cmd+W): starts the graceful close while its session runs. */
  closeWindow(): Promise<void>
  /** Shows analysis `n` of the window's set (Cmd+1..9, a click on the strip). */
  showAnalysis(n: number): Promise<void>
  /** The analysis strip's side and entries, about once a second; only the strip view listens. */
  onStripEntries(cb: (view: StripView) => void): Unsubscribe
  /** Moves the analysis strip between the bottom and the left of the window (the palette). */
  toggleStripSide(): Promise<void>

  settings: {
    get(): Promise<SettingsView>
    /** Saves the folder holding `analyses/`. It must already exist. */
    setRoot(input: string): Promise<SetRootResult>
    /** The native folder chooser; undefined when cancelled. Saves nothing. */
    chooseRoot(): Promise<string | undefined>
    /** Saves which tabs are on and their order; every analysis follows at once. */
    setTabs(tabs: TabPrefs): Promise<void>
    /** Saves the strip's side, what its entries show, and auto-hide. */
    setStrip(strip: StripPrefs): Promise<void>
    /** Fired in every window after a save. */
    onChange(cb: (settings: SettingsView) => void): Unsubscribe
  }

  doctor: {
    get(): Promise<DoctorView>
    /** Checks the tools again, and builds the venv again when its build failed. */
    recheck(): Promise<DoctorView>
    /** Fired in every window as the backend is prepared and checks finish. */
    onChange(cb: (view: DoctorView) => void): Unsubscribe
  }

  update: {
    get(): Promise<UpdateView>
    /** Keeps a fine-grained GitHub token, encrypted with the Keychain, and turns the updater on. */
    setToken(input: string): Promise<SetTokenResult>
    /** Forgets the token and turns the updater off; onChange brings the new view. */
    forgetToken(): Promise<void>
    /** Closes every analysis through the close flow, then installs the downloaded update and relaunches. */
    restart(): Promise<void>
    /** Fired in every window as the updater checks, downloads and fails. */
    onChange(cb: (view: UpdateView) => void): Unsubscribe
  }

  /** Which hints a long press shows: left Cmd the Cmd shortcuts and analysis numbers, left Ctrl the pane numbers. */
  onHints(cb: (kind: HoldKind | undefined) => void): Unsubscribe

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
  threadsAdd: 'threads:add',
  threadsEditOpen: 'threads:editOpen',
  threadsDeleteOpen: 'threads:deleteOpen',
  threadsCloseOpen: 'threads:closeOpen',
  threadsDeleteClosed: 'threads:deleteClosed',
  threadsMoveOpen: 'threads:moveOpen',
  notesRead: 'notes:read',
  notesAdd: 'notes:add',
  notesSave: 'notes:save',
  notesRun: 'notes:run',
  runRead: 'run:read',
  plotRead: 'plot:read',
  runRequest: 'run:request',
  trustFiles: 'trust:files',
  trustApprove: 'trust:approve',
  trustUnadopted: 'trust:unadopted',
  trustAdopt: 'trust:adopt',
  overviewMarkRead: 'overview:markRead',
  filesList: 'files:list',
  filesOpen: 'files:open',
  filesPreview: 'files:preview',
  filesOpenChart: 'files:openChart',
  searchContents: 'search:contents',
  windowNew: 'window:new',
  windowClose: 'window:close',
  analysisShow: 'analysis:show',
  stripSide: 'strip:side',
  settingsGet: 'settings:get',
  settingsSetRoot: 'settings:setRoot',
  settingsChooseRoot: 'settings:chooseRoot',
  settingsSetTabs: 'settings:setTabs',
  settingsSetStrip: 'settings:setStrip',
  doctorGet: 'doctor:get',
  doctorRecheck: 'doctor:recheck',
  updateGet: 'update:get',
  updateSetToken: 'update:setToken',
  updateForgetToken: 'update:forgetToken',
  updateRestart: 'update:restart',
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
  doctorChanged: 'doctor:changed',
  updateChanged: 'update:changed',
  hints: 'hints',
  stripEntries: 'strip:entries',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

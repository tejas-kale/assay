# Assay

A Mac desktop app for data analysis with Claude Code, laid out like RStudio: Claude Code in a terminal on the left,
Threads / Notes / Files top right, and Data / Plots / Code / History / Trust bottom right. It is a UI over the analysis
mod's folders (`~/Code/config/claude/analysis`): the mod is the backend, the files are the contract, and the app keeps
no database.

**One rule above all: there is one place where code runs, and every run is recorded.** Claude's `sql` and `python`
tools and the user's edits and re-runs all go through the mod, into numbered, immutable runs in `queries/`, in the one
kernel the app shows. Protect this in every change.

The code is the source of truth. `docs/slice-*.md` are the specs each slice was built from, kept as history.

## Install, run, test (on the Mac)

- `npm install` (postinstall repairs Electron's unpack on Node 26, rebuilds node-pty for Electron and fixes `spawn-helper`)
- `npm run dev`
- `npm test` (logic in `src/core`, no Electron needed), `npm run typecheck`
- `npm run install-app` builds `Assay.app`, ad-hoc signed, into `/Applications`; run it again after pulling changes.
  `npm run package` only builds it, into `dist/mac-arm64/`.

## Environment

- The analysis folder, which holds `analyses/`, is set in Settings (Cmd+,). The app asks on first run. Picking
  `analyses/` or one analysis inside it sets the folder above.
- `ASSAY_CLAUDE_BIN`: the wrapper to run (default `claude`, the Podman wrapper from the config repo, found through your
  login shell). The app sets `ASSAY_APP=1`, which makes the mod keep its own pane closed.
- Colours follow the macOS light or dark setting live (Ayu Light / Ayu Dark), all in `src/core/theme.ts`.

## Keys

Every shortcut is in `src/core/keymap.ts`: `COMMANDS` (Cmd keys, caught in main before the terminal) and `PANE_KEYS`
(single keys per pane). In the app, the palette's Show Shortcuts lists them all, and holding left Cmd shows hints.

## Where things are

- `src/core`: pure logic with tests (runs, facts, threads, note files, search, keymap, theme).
- `src/main`: Electron main; all file access (`files.ts`, `browse.ts`) and IPC (`ipc.ts`). The renderer never reads a
  path itself; `src/shared/ipc.ts` is the only contract between the two.
- `src/renderer`: React UI. `terminal.ts` is the only file that imports `ghostty-web`.
- The app talks to the mod through files: it writes `.assay/requests/<id>.json`, the mod answers in `.assay/replies/`,
  and writes `.assay/runs.json` and `.assay/trust/<name>.json` for run status and the trust review.

## The config repo

The mod and the `claude` wrapper live in `~/Code/config` (`claude/analysis`, `claude/bin`). Its tests:
`cd ~/Code/config/claude/analysis && /opt/homebrew/bin/claude plugin test .` (plain `claude` is the Podman wrapper and
refuses it). The mod is mounted from that folder, so a change applies from the next session.

## Not yet tried with a real Claude session

Built and tested with a stub Claude and simulated mod replies only:

1. `/an trust <name>` end to end: streamed checks, the "Trust?" question, the commit, and removing the `lib/` draft.
2. The Python kernel in a real container session: start, runs, interrupt, restart, Replay; the Bash guard on Python.
3. A re-run or edited query from the app reaching the session, its latency, and Postgres re-runs.
4. `new_note` from Claude, and Claude editing a note open in the reader.
5. Cmd+W and Cmd+Q closing a window while the wrapper finishes its git import.

## Driving the app without a person

- Run `npx electron-vite dev -- --inspect=9230 --remote-debugging-port=9222` with `ASSAY_CLAUDE_BIN` set to a stub
  script, so no real Claude starts. Drive the renderer over CDP (port 9222) with `Runtime.evaluate`,
  `Input.dispatchKeyEvent` and `Page.captureScreenshot`, and read the screenshots.
- CDP key events never reach main's `before-input-event`, so send Cmd shortcuts through the main inspector (port 9230,
  `includeCommandLineAPI: true` gives `require`):
  `webContents.getAllWebContents()[0].emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', code: 'KeyP', meta: true, shift: false, control: false, alt: false, isAutoRepeat: false })`.
- **Never test against real analyses.** Settings live in the user data folder the installed app shares. In the main
  inspector, call `app.setPath('userData', '<scratch>/ud')` with a `settings.json` whose root is a scratch copy, then
  reload. Check that the picker lists the scratch analysis before pressing anything.
- A change to main-process code needs the dev app restarted; the renderer hot-reloads.

## If the terminal fails

`src/renderer/terminal.ts` holds every assumption about `ghostty-web` in its header. It is the only file that imports
it, so swapping to xterm.js is a one-file change.

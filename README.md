# Assay

A Mac desktop app for data analysis with Claude Code, laid out like RStudio: Claude Code in a terminal on the left,
Threads / Notes / Files top right, and Data / Plots / Code / History / Steps / Trust bottom right. Its backend is this repo's
Claude Code plugin (`plugin/`): an MCP server, hooks and skills that Claude loads in the session the app starts. The
files are the contract between the two, and the app keeps no database.

**One rule above all: there is one place where code runs, and every run is recorded.** Claude's `sql` and `python`
tools and the user's edits and re-runs all go through the server, into numbered, immutable runs in `queries/`, in the
one kernel the app shows. Protect this in every change.

The code is the source of truth. `docs/slice-*.md` are the specs each slice was built from, kept as history.

## Install, run, test (on the Mac)

- `npm install` (postinstall repairs Electron's unpack on Node 26, rebuilds node-pty for Electron, fixes `spawn-helper`
  and runs `npm run build:server`)
- `npm run build:server` bundles the MCP server and the hook scripts with esbuild into `out/server/index.mjs` and
  `out/hooks/*.mjs`, which the plugin runs in the container with plain `node`. Run it after pulling server changes: the
  wrapper mounts this checkout, so the next session uses the new bundle.
- `npm run dev`
- `npm test` (logic in `src/core`, the server in `src/server`, the hooks in `src/hooks`; no Electron needed),
  `npm run typecheck`. With `ASSAY_TEST_VENV` naming a Linux venv that has ipykernel (`python/tests/test_venv.sh
  <dir>` builds one in `<dir>/src/.venv`), the MCP test runs a real kernel.
- Python helpers: `python/tests/test_venv.sh <scratch>`, then `<scratch>/src/.venv/bin/python -m pytest python/tests`.
- `npm run install-app` builds `Assay.app`, ad-hoc signed, into `/Applications`; run it again after pulling changes.
  `npm run package` only builds it, into `dist/mac-arm64/`.

## Environment

- The root, which holds `analyses/`, `dictionaries/` and `trusted/`, is set in Settings (Cmd+,). The app asks on first
  run. Picking `analyses/` or one analysis inside it sets the folder above. Every analysis is
  `<root>/analyses/<slug>/` holding `analysis.yaml` (`title`, `created`, and optional `profile`, `warehouse`,
  `pg_database`). The slug comes from the title once and never changes; editing the title (palette: Rename analysis)
  leaves the folder alone. Claude starts in the root, and each prompt names the open analysis.
- `npm run migrate:root [root] [--apply]` converts the old layout (`.analysis` markers, `investigations/`,
  `explorations/`) once: a dry run by default, `--apply` to act. It never overwrites and does not touch git.
- `ASSAY_CLAUDE_BIN`: the wrapper to run (default `claude`, the Podman wrapper from the config repo, found through your
  login shell), started with `--plugin-dir /opt/assay/plugin`. The app sets `ASSAY_APP=1` (the wrapper then mounts
  `$ASSAY_DIR`, default `~/Code/assay`, at `/opt/assay`), `ASSAY_ANALYSIS` (the open analysis) and `ASSAY_ROOT` (the
  Settings folder, which holds `dictionaries/` and `trusted/`).
- Colours follow the macOS light or dark setting live (Ayu Light / Ayu Dark), all in `src/core/theme.ts`.

## Keys

Every shortcut is in `src/core/keymap.ts`: `COMMANDS` (Cmd keys, plus Ctrl+1..3 for the panes, caught in main before
the terminal) and `PANE_KEYS` (single keys per pane). In the app, the palette's Show Shortcuts lists them all. Holding
left Cmd shows the Cmd shortcuts and the analysis numbers in the strip; holding left Ctrl shows the pane hints.

## Several analyses in one window

One window holds up to nine analyses (`docs/multi-analysis-window.md`). Each is its own `WebContentsView` running the
whole renderer with its own Claude session, so a hidden one keeps running and keeps its UI state. Cmd+1..9 switches,
Cmd+N opens another from the picker, Cmd+W closes the shown one. The strip along the bottom (`#strip`, the same
renderer bundle) shows each analysis's Claude state, from `.assay/claude.json` that the plugin's `state` hook writes,
and any run in progress. The open set is saved in the user data folder (`open-analyses.json`) and reopened at launch.

## Where things are

- `src/core`: pure logic with tests (runs, root notes, threads, search, keymap, theme).
- `src/main`: Electron main; all file access (`files.ts`, `browse.ts`) and IPC (`ipc.ts`). The renderer never reads a
  path itself; `src/shared/ipc.ts` is the only contract between the two.
- `src/renderer`: React UI. `terminal.ts` is the only file that imports `ghostty-web`.
- `src/server`: the MCP server `assay`, one per Claude session (plugin `.mcp.json`). Claude's tools are
  `mcp__plugin_assay_assay__<tool>` (Claude Code's name for a plugin's MCP tools): `sql`, `python`, `trusted`, `park`,
  `close`, `focus`, `order`, `note`, `revise_note`, `link_notes`, `note_labels`. It owns the kernel
  (`python/analysis_kernel.py serve`), started with the server and ended with it.
- `src/hooks`: UserPromptSubmit (the rules on each typed prompt, the trusted calculations, the user's runs since the
  last prompt), PreToolUse on Bash (no Python through Bash) and on Write/Edit/NotebookEdit (nothing into
  `$ASSAY_ROOT/trusted` or `dictionaries`, nor into another analysis). `plugin/skills`:
  - `assay:resume`: report where the analysis stands and offer past root notes to link.
  - `assay:wrap-up`: close threads, write findings as root notes, settle weak citations, link the notes read.
  - `assay:propose-trusted`: draft a trusted calculation or dictionary entry, with every file Check needs.
- `python/`: `analysis_db`, `analysis_kernel`, `analysis_trust`, `analysis_sql` (the SQL rules on Claude's `sql`
  calls and on SQL templates at Check, and the lineage and step queries the Steps tab draws and runs; docs/slice-9.md), built into venv-assay by `claude-pkg venv-assay`.
- The app talks to the server through files: it writes `.assay/requests/<id>.json` (`sql`, `python`, `interrupt`,
  `restart`, `replay`, `lineage`, `steps`, `trust-list`, `trust-check`, `trust-answer`), the server answers in
  `.assay/replies/`, writes next to a SQL run in `queries/` when the Steps tab asks (`NNN.lineage.json`;
  `NNN.steps.json` and each step's `NNN.k_<name>.sql`, `.csv` and `.counts.sql`: steps are not runs and take no
  number, and `q(N, step=k)` in the kernel loads step k's rows), and
  writes `.assay/runs.json` and `.assay/trust/<name>.json` for run status and the trust review. For the prompt hook
  only, it writes `.assay/user-runs.json` (the user's runs) and `.assay/step-notices.json` (step checks that failed),
  both emptied by the hook, and `.assay/session.json` (the kernel's python). No tool of Claude's can start or answer a review: only the Trust tab's buttons do.

## The config repo

The `claude` wrapper and `claude-pkg` live in `~/Code/config` (`claude/bin`). With `ASSAY_APP=1` the wrapper mounts this
checkout read-only at `/opt/assay` and passes `ASSAY_ROOT` and `ASSAY_ANALYSIS` through; `claude-pkg venv-assay`
builds venv-assay from `python/` here. The analysis mod (`claude/analysis`) is no longer loaded.

## Not yet tried with a real Claude session

Built and tested with a stub Claude, simulated replies and the MCP SDK's client only (slice 5's Mac checklist, in
`docs/slice-5.md`, covers them):

1. The plugin in the Podman container: the server, the hooks and the skills under the wrapper.
2. The Trust tab's Check, Trust and Reject against a real proposal, the commit, and removing the `lib/` draft.
3. A re-run or edited query from the app reaching the session, its latency, and Postgres re-runs.
4. `note` from Claude, and Claude `revise_note` on a note open in the reader.
5. Cmd+W and Cmd+Q closing an analysis while the wrapper finishes its git import.
6. The multi-analysis window: switching, the strip's Claude states from the `state` hook, and relaunch restore.

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

# Handoff: Assay

Plan agreed in a grilling session on 2026-11-01. Nothing is built. This file was written in the user's config repo
(`~/Code/config`) and moves to this app's own repo, so "the config repo" below means `~/Code/config`.

Read these in the config repo before building:

- `claude/analysis/README.md`: what the analysis mod does today.
- `claude/analysis/HANDOFF.md` and `claude/analysis/TRUST-HANDOFF.md`: why it does it.
- `LEARNINGS.md`: gotchas of the Podman sandbox and of Claude Code mods.

## Goal

A desktop app for data analysis with Claude Code, laid out like RStudio, so the user never leaves it to read or run
what Claude did. It must make two things easy:

1. See the exact code Claude wrote, its result, and how far to trust it.
2. Run that code, or an edited copy, in the same Python session Claude uses.

The notebook approaches failed because Claude ran code in one place and the user read it in another: marimo was not
kept up to date, and code had to be run twice. Markdown code blocks run from Vim would still mean leaving the app.
**There is one place where code runs, and every run is recorded. Protect this in every design choice.**

The first iteration should be as quick and cheap as possible.

## Layout

```
+---------------------------+---------------------------------+
| Claude Code               | [Notes] [Threads]               |
| ghostty-web + node-pty    | facts + linked note files       |
| `claude` wrapper          +---------------------------------+
| in Podman                 | [Data] [Plots] [Code] [History] |
|                           | one current run, latest         |
|                           | unless pinned                   |
+---------------------------+---------------------------------+
```

## Facts

Checked on 2026-11-01. "Read" means from the config repo's source; nothing here was run in Electron.

The analysis mod (`claude/analysis/` in the config repo, read):

- It is active in a folder with a `.analysis` file. The folder holds `notes.md`, `threads.md`, `queries/`,
  `notebook.md`, `lib/` and `tests/`. Shared `dictionaries/` and `trusted/` live in `~/Code/notes-src`.
- Claude's tools are `sql`, `trusted`, `note`, `revise_note`, `link_note`, `park`, `close`, `focus`, `order` and
  `server`, all as `mcp__analysis__*`.
- Every query is saved as `queries/NNN_<slug>.sql`, and `.csv` when it worked. Numbers are never reused, and the mod
  claims them in a queue (`runQuery` in `hooks/register.tsx`). The `sql` tool returns at most 50 rows to Claude.
  A Databricks result over 4 MiB of output is refused with "Aggregate it or add a LIMIT".
- Note labels are derived by the mod, never chosen by Claude: `trusted`, `queried` or `unverified` (`deriveLabel` in
  `hooks/model.ts`). A trusted note whose calculation changed shows as `stale`.
- `/an trust <name>` runs the checks and shows a review card in the terminal pane. Only the user can approve, and the
  mod commits the approval.
- The mod API seen in use includes `$.process.run`, `$.process.spawn`, `$.fs`, `$.env`, `$.clock.every`,
  `$.tool.register`, `$.ui.open` and `on('tool.call', ...)`. **No API for listening on a port or accepting requests
  from outside was seen.** Tools seen in use return `{ result: string }`; returning an image is unverified.
- `$.fs` has no append. A mod may pass `$` only to top-level function declarations (`LEARNINGS.md`).
- The `tool.call` handler in `hooks/register.tsx` already denies Claude's writes to `dictionaries/` and `trusted/`.
  Bash is not guarded today.

The sandbox (`claude/bin/claude` and `claude/bin/_claude.sh` in the config repo, read):

- The `claude` wrapper runs on the Mac and starts Claude Code in a Podman container. Traffic goes through an allowlist
  proxy, and the Databricks and Postgres credentials are set up for the container.
- `notes-src/.venv` is built in the container (`claude-pkg uv sync`). A `.venv` built on the Mac does not run there,
  and the reverse holds. So Python must run in the container.
- A per-session socat forwarder (`marimo_forward_ensure`) publishes the first free port of 2718–2727 on the Mac's
  `127.0.0.1` to the same port in the container, and passes it as `ANALYSIS_PORT`. `ANALYSIS_FORWARD` says `owner`,
  `taken` or `off`. It is on only for sessions rooted in notes-src or started in a folder with `.analysis`.
- Host edits raise no inotify events in the container, so anything in the container must poll for files the Mac wrote.
- When the session ends, the wrapper still runs `agent_git_import` and releases the forwarder.
- Packages are installed with `claude-pkg uv|npm|go ...`. Agents in the sandbox cannot run Electron and have no display.

The terminal (search snippets only, not tested):

- `ghostty-web` (github.com/coder/ghostty-web, npm) compiles Ghostty's parser to WASM behind an xterm.js-compatible
  API, about 400 KB. It does not use the Ghostty config or native renderer.
- GitHub issues against Claude Code report broken text selection and laggy scrolling in fullscreen mode on
  xterm.js-based terminals. `ghostty-web` has not been tried against either.

## Decisions

### Shell and terminal

- Electron with `ghostty-web` and `node-pty`. Claude Code runs as the real CLI in a real pty: no Agent Client Protocol,
  no bridge, no SDK.
- The pty runs the user's existing `claude` wrapper from the config repo, in the analysis folder, so the sandbox's proxy,
  allowlist and read-only rules all still apply.
- It runs from source on the Mac for v1 (`npm run dev` or similar), unpackaged and unsigned.

### Opening an analysis

- The app opens on a keyboard-driven fuzzy picker of analyses, newest first, with a field to create a new one.
- One window holds one analysis, one Claude and one kernel. Cmd+N opens another window. The port range allows ten sessions.

### Mod and app

- The mod stays the backend and the app is a UI over the analysis folder's files. The app keeps no database.
- When launched from the app, the mod hides its terminal pane. A plain `claude` in Ghostty keeps the pane.
- The mod's tools, labels and tests stay. Do not fork them.

### Python: one shared kernel

- Claude gets a `python` tool (`mcp__analysis__python`), shaped like `sql`, that runs in the kernel the app shows. Claude's
  results appear in the app at once, with nothing to re-run.
- You can re-run or edit a run in the same kernel. Runs execute one at a time, in the order they arrive.
- A hook in the mod's `tool.call` handler refuses Bash calls that run Python in an analysis folder (`python script.py`,
  `python -c`, heredocs) and points Claude to the tool. `pytest` and package commands stay allowed. Accepted: a determined
  workaround could get past it.
- The kernel starts with the analysis session, survives `/clear`, and ends with the container. Variables are then lost.
- A Replay action re-runs chosen saved runs in a new kernel.
- `df = q(12)` is preloaded and loads query 12's saved result with no warehouse call. The run records which queries it read.
- Python captures stdout, errors, tables and static PNG or SVG plots from any library, saved under the run's number.
  There are no interactive plots in v1.
- Claude gets at most 50 rows and the plot image, so it can check its own chart. The Data tab shows all rows.

### Runs

- Runs are immutable. An edit makes a new numbered run, marked as the user's and linked to its original.
- On the user's next prompt, the per-prompt rules tell Claude which runs the user made, so it is not surprised by the
  changed state.
- A re-run or edited SQL query takes the same path as Claude's `sql` tool, so it is saved and labelled the same way.

### Data pane

- Tabs are Data, Plots, Code and History. All show one current run.
- The current run follows Claude's latest. The active tab does not change by itself; other tabs get a marker when they have
  new content. A key pins the current run. Choosing a run in History sets the current run.
- The Code tab shows the exact code and its trust label, and opens read-only in CodeMirror 6 with Vim mode. `i` or Cmd+E
  edits, and Cmd+Enter runs it as a new run.

### Trust

- The new `computed` label applies to a note citing a successful Python run, which can depend on kernel state. A failed run
  gives `unverified`, as a failed query does. `trusted` and `queried` keep their meaning.
- `/an trust` opens a review view in the data pane of the app: code, a line per check, a sample of the live rows, `y` to
  approve and `r` to reject. The mod still runs the checks and commits. Only the user can approve.

### Notes and threads

- Notes and Threads are two tabs at the top right.
- `notes.md` keeps one-line facts with derived labels.
- New files, `notes/NNN-<slug>.md`, hold prose and code. They link with `[[slug]]` and cite runs with `[q 012]`. Claude writes
  them as a Zettelkasten as the analysis goes on. The tab shows both kinds, with backlinks, and a citation jumps to that run.
- Threads stay as they are.
- The user can edit a note file in CodeMirror, and add, edit or delete facts and threads by keyboard. Fact labels are
  always re-derived.

### Keyboard

The app must work with minimal mouse use. Cmd shortcuts are caught before the terminal, so they never reach Claude.

```
Cmd+1        terminal                 Cmd+Shift+D  Data tab
Cmd+2        notes and threads        Cmd+Shift+P  Plots tab
Cmd+3        data pane                Cmd+Shift+C  Code tab
Cmd+P        command palette          Cmd+Shift+H  History tab
Cmd+Enter    run current code         Cmd+N        new window

In panes: j/k move, Enter open, / search
```

Every action, including ones with no shortcut of their own (Replay, restart kernel, pin), is in the palette.

### marimo

Remove it when the kernel lands (slice 3), so Ghostty sessions keep a notebook until then. In the config repo this covers:

- `hooks/server.ts`, `hooks/notebook.ts`, `hooks/lean.mjs` and the `Stop` hook in `hooks/hooks.json`.
- The Notebook tab, the notebook rules in `analysisRules`, the `notebook.md` template and the `server` tool.
- `skills/resume/SKILL.md` (calls `server`, reads `notebook.md`), `migrate` (adds `notebook.md`) and their tests.
- `marimo` and `[tool.marimo.runtime]` in `notes-src/pyproject.toml`, and `marimo.notebook_dir()` in `analysis_db.py`.

Keep `analysis_db.py`, `lib/` and `tests/`, and the per-session forwarder. Leave existing `notebook.md` files where they are.
After this, a plain `claude` in Ghostty can use `python` but cannot show plots. Accepted.

## Integration

This is the proposed wiring. It rests on the Facts above, and the user has agreed only to the port and token.

### Two repos

The app lives in its own repo. The mod and wrapper changes live in the config repo. A sandbox session sees only the
project it was started in, so **config-repo changes need a session started there**. Keep them to small commits, and do them
before the app slice that needs them.

### Channels

```
App (Mac)                                  Container
  node-pty -----------------------------> claude wrapper -> Claude Code + mod
  watch analysis folder <---- files ----- mod and runner write runs, notes, state
  HTTP/WS to 127.0.0.1:<port> + token --> runner -> ipykernel (one per session)
  write requests/*.json ---- files -----> mod polls ($.clock.every), then acts
```

1. **Reading state:** the app watches the analysis folder. Files are the contract.
2. **Kernel:** the mod spawns a small Python runner (`$.process.spawn`, as it does marimo today). The runner uses
   `jupyter_client` and `ipykernel`, listens on `ANALYSIS_PORT` with a per-session token, and saves each run. The mod's
   `python` tool and the app both talk to it. `ipykernel` and `jupyter_client` join `notes-src/pyproject.toml`.
3. **Actions only the mod can do** (SQL re-runs, approvals, label changes): the app writes a request file and the mod polls for
   it, since no way to reach the mod over a port was seen.
4. **Discovery:** the mod writes `.assay/session.json` (port, token, kernel status), kept out of git. If
   `ANALYSIS_FORWARD` is `taken` or `off`, the kernel panel says so, and the rest of the app still works.

### Config-repo changes

- `claude/bin/claude`: pass `-e ASSAY_APP`, which the app sets to `1`. The mod reads it to hide the pane.
- Mod: the `python` tool, the runner, the Bash guard, the `computed` label, the request polling, the session file, the run
  notice in the per-prompt rules, and a rule to write notes under `notes/`.

### Run files (a starting point; change freely)

```
queries/NNN_<slug>.sql       as today; new header lines: -- author: user, -- from: 012
queries/NNN_<slug>.csv       as today
queries/NNN_<slug>.py        the exact Python code run
queries/NNN_<slug>.json      author, from, reads, kernel id, status, times, stdout, error, outputs list
queries/NNN_<slug>.t1.csv    each table a Python run displays
queries/NNN_<slug>.p1.png    each plot
```

Python and SQL share one number sequence, so `[q 012]` always names one run. Check `parseQueryName` and the query listing
in `hooks/model.ts` and `hooks/register.tsx` when adding the new extensions.

## Build slices

Each slice is usable alone, and the user may stop after any. Estimates assume Claude builds and the user tests on the Mac.

1. **Terminal, notes and threads (half a day).** Electron window, picker, `ghostty-web` + `node-pty` on the wrapper, the pane
   hidden, keyboard focus model, Notes and Threads tabs reading the files, with fact and thread edits.
2. **SQL runs (half a day).** Data, Code and History tabs over `queries/`, trust labels, current-run following and pinning,
   CodeMirror, SQL re-run and edit through a request file.
3. **Shared kernel and Plots (1 day).** Runner, `python` tool, `q(N)`, Bash guard, `computed`, Plots tab, Python re-run and edit,
   the run notice to Claude, Replay. Remove marimo at the end of this slice.
4. **Zettelkasten notes and trust review (1 day).** `notes/` files, links, backlinks, citations, note editing, and the `/an trust`
   review view.

## Verify first

Do these before building on top of them. Items 1 and 2 are the first work in slice 1.

1. **`ghostty-web` with Claude's fullscreen mode** (`CLAUDE_CODE_NO_FLICKER=1`, which the wrapper sets): rendering, mouse,
   text copy, scrolling and resize, with a long session. If it fails, `xterm.js` should replace it with mostly an import
   change, though it has reported fullscreen issues of its own.
2. **Cmd shortcuts** are caught before the terminal, and Claude's own keys all still arrive.
3. **`node-pty` under Electron** needs a rebuild for Electron's ABI. Dependencies for running the app must be installed on the
   Mac: `node_modules` built in the Linux container will not load native modules there, as with `.venv`. Keep logic tests free
   of native modules so they also run in the sandbox.
4. **Closing a window** must let the wrapper finish `agent_git_import` and release the forwarder. Do not kill it outright.
5. **Starting from an analysis folder:** the wrapper finds `notes-src/.venv`, the forwarder is `owner`, and the mod activates.
6. **File watching on the Mac** sees writes from the container promptly, including rename-over saves. Fall back to polling if not.
7. **Mod tool results:** can a tool return an image? If not, return the PNG's path and have Claude open it with `Read`.
8. **Mod latency:** does request-file polling feel fast enough for SQL re-runs and approvals?

## Open for the build

Decide these while building, and record each here:

- Does the mod reach the runner with `fetch`, or with `$.process.run` and `curl`?
- Could file requests also carry Python runs? If so, the port, token and forwarder could go. Output streaming and interrupts
  decide this. The port and token are what was agreed, so ask the user before dropping them.
- Does `q(N)` return pandas or polars? Both are in the venv, and capture must handle both.
- What are the limits on tables and plots saved per run, and on rows the Data tab loads at once?
- What is the shortcut for interrupting a run? Claude's `python` tool also needs a timeout; `sql` uses ten minutes.
- Do Replay's runs get new numbers marked as replays? This fits immutable runs and is the suggested answer.
- What do note files show for trust? Suggested: no label on the file, and each cited run's label shown beside its citation.
- How does Claude create a note file: with `Write` under a rule, or with a new tool that claims the number?

### Decided while building

- **Kernel link (user, 2026-11-02): files only.** Python runs from the app go through request files, as SQL does in
  slice 2b, with interrupts as a request too. The mod talks to the runner over the spawned process's stdin/stdout. The
  port, token, forwarder use and `.assay/session.json` are dropped from the plan, and the "Channels" and "Discovery"
  wiring above are superseded on this point. Accepted cost: output shows in steps of about 0.5 s, not live.

- **Slice 2b** (`docs/slice-2b.md`): the app writes `.assay/requests/<id>.json`; the mod polls it every 500 ms, runs it
  through `runQuery` with `-- author: user` and `-- from: NNN` header lines, and answers in `.assay/replies/<id>.json`.
  A user's run is never `trusted`. Editing starts from the SQL on screen (formatted unless `o`), header lines removed.

- **Slice 3** (`docs/slice-3.md`, 2026-11-02): the mod runs a long-lived `serve` process per session
  (`$.process.spawn`, events on stdout) that owns an `ipykernel`, and a short `run` client per run (`$.process.run`).
  `$.process.spawn` writes stdin only once, so runs cannot go over the serve process's stdin. A Python run's output
  streams by rewriting its `.json` every 0.5 s. `q(N)` returns pandas. Limits per run: 20 tables, 20 plots, 100 000
  rows per table, 1 MB stdout. Interrupt is Cmd+.; Claude's `python` tool times out after 10 minutes. Replay runs get
  new numbers marked `# replay: NNN`, in a new kernel, and stop at the first failure. The kernel starts when the
  session starts in or adopts an analysis. The runner `analysis_kernel.py` is run by path from notes-src.
- **Molten notebook (user, 2026-11-02):** marimo was already replaced by a Molten `notebook.md` (config `dfa8910`).
  "Remove marimo" in slice 3 now means: the mod and Assay stop knowing about `notebook.md` (no `run_notebook`, rules,
  Notebook tab, template or Stop hook). Molten stays as the user's private tool; `analysis_notebook.py` is kept.

## Not in v1

- Signing with a real identity, notarising, auto-update; platforms other than the Mac. (A local ad-hoc-signed
  `Assay.app` exists: `npm run install-app`.)
- Interactive plots.
- Several analyses as tabs in one window.
- A kernel that survives the session.
- Obsidian-style note features: file tree, split previews, link autocomplete.
- Native libghostty embedding.
- Monaco or embedded Neovim as the editor.

## Status

As of 2026-11-02 (after slice 2b).

### Done and run on the Mac

- **Slice 1**, run and fixed: picker, Settings (the analysis folder; picking an analysis or `analyses/` resolves to the
  folder above), terminal, Threads and Notes, Cmd shortcuts, Show Shortcuts (palette), left-Cmd hints. Threads is the
  first tab. Cmd+2 pressed again cycles Threads → Notes → Files.
- **Pane hidden** (config repo): with `ASSAY_APP=1` the mod never opens its pane and `/an` points to the app.
  `claude/bin/claude` passes `-e ASSAY_APP`. `/an trust` still opens the pane: its review view is slice 4.
- **Run status** (config repo, beyond the brief): with `ASSAY_APP=1` the mod writes `.assay/runs.json`
  (`{ running: { number, startedAt } | null, failed: { "<n>": message } }`) before each `.sql` and after each result,
  and `.assay/.gitignore` (`*`). The app shows "running" and failures from it.
- **Slice 2, part:** Data, Code and History tabs over `queries/` (`src/core/runs.ts`, `src/renderer/components/DataPane.tsx`).
  Current run follows Claude's latest; choosing in History holds a run until "follow latest". Data has a cell cursor
  (h/j/k/l, Enter shows the row, y copies, the full cell under the table). Code is read-only CodeMirror 6 with SQL
  highlighting and `sql-formatter` for display (`o` shows the exact file text) (`CodeView.tsx`). Links: `c` Data → Code,
  `d` Code → Data.
- **Files tab** (not in the original plan): every file in the analysis, newest first; Enter opens text in Neovim in a new
  Ghostty window, previews images, and opens the rest in the default app (`src/core/files.ts`, `src/main/browse.ts`).
- **Install:** `scripts/postinstall.mjs` repairs Electron's unpack on Node 26; `npm run install-app` builds `Assay.app`
  (electron-builder, ad-hoc signed) into `/Applications`.

- **Slice 2b** (`docs/slice-2b.md`): trust labels (`trusted`, `queried`, `unverified`, `running`) with `you` and `from NNN`
  in History and the run header; `p` and the palette pin the current run; dots on Data, Code and History for unseen
  content; `i` or Cmd+E edits SQL in CodeMirror with Vim mode; Cmd+Enter sends the edit, or re-runs the current run,
  as a request file the mod polls (config repo `c3ac6af`). Smoke-tested with a stub Claude and a simulated mod reply;
  the mod side is covered by its own tests but has not run against a live session.

- **Fixes after slice 2b:** Shift+Enter sends a newline to Claude (ESC CR); Files opens Neovim as a new tab in the
  front Ghostty window over AppleScript (falls back to a new instance); a window's title is `<analysis> — Assay`.

### Left

- **Slice 2b, untested live:** a real Claude session picking up a request (mod poller), the request-to-run latency
  (Verify first item 8), and Postgres re-runs.
- **Slice 3** and **slice 4** as written under Build slices.
- **Open for the build** above is still open (none of it was needed for slice 2b).
- Untested by Claude: a live Claude session in the app (the user has used it), physical Cmd keys, Cmd+W/Cmd+Q closing.

### How this app was tested on the Mac without a person

- Run `npx electron-vite dev -- --inspect=9230 --remote-debugging-port=9222` with `ASSAY_CLAUDE_BIN` set to a stub script,
  so no real Claude starts. Drive the renderer over CDP (port 9222) with `Runtime.evaluate`, `Input.dispatchKeyEvent` and
  `Page.captureScreenshot`, then read the screenshots.
- CDP key events never reach main's `before-input-event`, so Cmd shortcuts are sent through the main inspector (port 9230,
  `includeCommandLineAPI: true` gives `require`):
  `webContents.getAllWebContents()[0].emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', code: 'KeyP', meta: true, shift: false, control: false, alt: false, isAutoRepeat: false })`.
- **Never test against the user's analyses.** Settings live in the user data folder that the installed app shares. In the
  main inspector, call `app.setPath('userData', '<scratch>/ud')` with a `settings.json` whose root is a scratch copy, then
  reload the page. Check that the picker lists the scratch analysis before pressing anything.
- A change to main-process code needs the dev app restarted; the renderer hot-reloads.
- The config repo is at `~/Code/config`; this session could edit it directly. Its tests:
  `cd ~/Code/config/claude/analysis && /opt/homebrew/bin/claude plugin test .` (plain `claude` is the Podman wrapper).
  `~/.local/bin/claude` links to `claude/bin/claude`, and the mod is mounted from `claude/analysis`, so changes apply on the
  next session.

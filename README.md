# Assay

A Mac desktop app for data analysis with Claude Code, laid out like RStudio: Claude Code in a terminal on the left,
Overview / Threads / Notes / Files top right, and Data / Plots / Code / History / Steps / Trust bottom right. Its backend is this repo's
Claude Code plugin (`plugin/`): an MCP server, hooks and skills that Claude loads in the session the app starts. The
files are the contract between the two, and the app keeps no database.

**One rule above all: there is one place where code runs, and every run is recorded.** Claude's `sql` and `python`
tools and the user's edits and re-runs all go through the server, into numbered, immutable runs in `queries/`, in the
one kernel the app shows. Protect this in every change. How to work on Assay: `AGENTS.md`.

The code is the source of truth. `docs/slice-*.md` are the specs each slice was built from, kept as history.

## Install, run, test (on the Mac)

- Assay needs, on your login shell's PATH: Claude Code (`claude`), `node` 22 or later (`brew install node`), `uv`
  (`brew install uv`) and `databricks` (`brew install databricks/tap/databricks`). Settings (Cmd+,) has a Doctor that
  checks them and names each fix; only a missing `claude` stops an analysis from opening. Nothing is bundled.
- `npm install` (postinstall repairs Electron's unpack on Node 26, rebuilds node-pty for Electron, fixes `spawn-helper`
  and runs `npm run build:server`)
- `npm run build:server` bundles the MCP server and the hook scripts with esbuild into `out/server/index.mjs` and
  `out/hooks/*.mjs`, which the plugin runs with plain `node`. Run it after changing them: `npm run dev` uses this
  checkout as the backend.
- `npm run dev`: the backend is this checkout, and the venv is `venvs/dev/` in the app's data folder, built editable
  from `python/` at each launch, so edits to the helpers apply at once.
- `npm run check`: typecheck, lint, every test with coverage, and the ratchet; `git push` runs it first. `npm test`
  runs only the tests. Python runs from `python/`'s locked project, synced by uv into the root `.venv`. Details in
  `docs/process/testing.md`.
- `npm run install-app` builds `Assay.app`, ad-hoc signed, into `/Applications`; run it again after pulling changes.
  `npm run package` only builds it, into `dist/mac-arm64/`.

## The backend in the app

The app ships its backend in `Contents/Resources/backend/`: `plugin/`, `out/server/`, `out/hooks/` and `python/`
(the helpers, `pyproject.toml` and `uv.lock`), laid out as in this repo. At launch it copies them, once per version,
to `~/Library/Application Support/Assay/backend/<version>/`, and builds the venv there with
`uv sync --frozen --no-editable` into `venvs/<version>/`, in the background (Settings shows `Preparing Assay ...`).
It keeps this version's and the previous one's folders and deletes older ones. A package the tools need goes in
`python/pyproject.toml`, locked with `uv lock`; the next release builds it.

## Environment

- The root, which holds `analyses/`, `dictionaries/` and `trusted/`, is set in Settings (Cmd+,). The app asks on first
  run. Picking `analyses/` or one analysis inside it sets the folder above. Every analysis is
  `<root>/analyses/<slug>/` holding `analysis.yaml` (`title`, `created`, and optional `profile`, `warehouse`,
  `pg_database`). The slug comes from the title once and never changes; editing the title (palette: Rename analysis)
  leaves the folder alone. Claude starts in the root, and each prompt names the open analysis.
- `npm run migrate:root [root] [--apply]` converts the old layout (`.analysis` markers, `investigations/`,
  `explorations/`) once: a dry run by default, `--apply` to act. It never overwrites and does not touch git.
- `ASSAY_CLAUDE_BIN`: the launcher to run instead of plain `claude` (found through your login shell), started with
  `--plugin-dir "$ASSAY_BACKEND/plugin"`. The variables the app sets, and what a launcher that runs Claude elsewhere
  must provide, are in `docs/process/launch-contract.md`.
- Postgres runs need `rds-psql`, which only a launcher provides; without it they fail with a pointer to the contract.
- Colours follow the macOS light or dark setting live (Ayu Light / Ayu Dark) which are all in `src/core/theme.ts`.

## Keys

Every shortcut is in `src/core/keymap.ts`: `COMMANDS` (caught in main before the terminal) and `PANE_KEYS` (single
keys per pane). Pane shortcuts use Ctrl: Ctrl+1..3 focus a pane and Ctrl+Shift+letter shows a tab (Ctrl+Shift+C Code,
Ctrl+Shift+D Data, ...); Ctrl+0 zooms the terminal to the whole analysis and back. Cmd is for analyses and the app:
Cmd+1..9, Cmd+N, Cmd+W, the palette, search and Settings, plus Cmd+Enter, Cmd+E and Cmd+. on runs. In the app, the
palette's Show Shortcuts lists them all. Holding left Cmd shows the Cmd shortcuts and the analysis numbers in the strip;
holding left Ctrl shows the pane and tab hints.

## Overviews

The Overview tab (`⌃⇧O`, docs/slice-10.md) shows the open analysis's `overview.md` and, with `s`, the system overview
it names on one of its first 5 lines (`System: systems/<name>.md`, in the root). `d` shows a diff against the text
last marked read with `m` (kept in `.assay/overview-read/`); the header shows the line count, amber above 50.

## Trusted pieces: blocks, definitions, includes

Slice 10 (docs/slice-10.md). A **block** is a trusted SQL template whose front matter has a `block:` contract (grain and
columns); the Trust tab's Check runs it live, checks its grain and compares it row by row with `<name>.rebuild.sql`, an
independent rebuild by Codex (or an Opus model in Copilot). Claude's SQL **includes** blocks and dictionary definitions
by name: `x AS ({{ block(p => 'v') }})`, `WHERE {{ client_entry(s) }}`. The server expands them (`analysis_sql
expand`), keeps the SQL as written under a `-- built from:` line, saves the expanded SQL as `queries/NNN.expanded.sql`
(first line `-- blocks: cte=block,...`) and runs that; Steps shows each block as one step. The **retype check**
(`analysis_sql retype`) warns when Claude's SQL writes a piece's logic out by hand; a `-- retype: <piece>: <why>`
comment silences it. A run's warnings are kept in `queries/NNN.notices.json` and shown above its code.

## Several analyses in one window

One window holds up to nine analyses (`docs/multi-analysis-window.md`). Each is its own `WebContentsView` running the
whole renderer with its own Claude session, so a hidden one keeps running and keeps its UI state. Cmd+1..9 switches,
Cmd+N opens another from the picker, Cmd+W closes the shown one. The strip along the bottom, or down the left after
the palette's Move analysis strip (`#strip`, the same renderer bundle), shows each analysis's title and Claude state, from `.assay/claude.json` that the plugin's `state` hook writes,
and any run in progress. The open set is saved in the user data folder (`open-analyses.json`) and reopened at launch.

## Launchers

The user's Podman wrapper lives in the config repo (`~/Code/config`, `claude/bin`), outside Assay. It is one launcher
among others, set with `ASSAY_CLAUDE_BIN`, and honours `docs/process/launch-contract.md`. Isolating code execution is
the launcher's job, not Assay's.

## Not yet tried with a real Claude session

Built and tested with a stub Claude, simulated replies and the MCP SDK's client only (slice 5's Mac checklist, in
`docs/slice-5.md`, covers them):

1. The plugin under plain Claude Code and under the Podman launcher: the server, the hooks and the skills.
2. The Trust tab's Check, Trust and Reject against a real proposal, the commit, and removing the `lib/` draft.
3. A re-run or edited query from the app reaching the session, its latency, and Postgres re-runs.
4. `note` from Claude, and Claude `revise_note` on a note open in the reader.
5. Cmd+W and Cmd+Q closing an analysis while the wrapper finishes its git import.
6. The multi-analysis window: switching, the strip's Claude states from the `state` hook, and relaunch restore.

## If the terminal fails

`src/renderer/terminal.ts` holds every assumption about `ghostty-web` in its header. It is the only file that imports
it, so swapping to xterm.js is a one-file change.

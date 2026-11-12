# Assay

A Mac app for data analysis with Claude Code. `README.md` covers install, environment, keys and features.

**One rule above all: there is one place where code runs, and every run is recorded.** Claude's `sql` and `python`
tools and the user's edits and re-runs all go through the server, into numbered, immutable runs in `queries/`, in the
one kernel the app shows. Protect this in every change.

## Session flow

- Commit on the session branch. The user pushes.
- Run `npm run check` before every commit, and fix what it reports until it passes.
- Every file meets the lint rules and the 90% coverage bar; there are no baselines. Fix a violation in the code,
  never by disabling a rule.
- Write each commit subject as a release note: what changed for the user.
- Add a `Release: minor` or `Release: major` trailer when the change warrants more than a patch release.

## Developer docs

`docs/` holds user and developer documentation only. Specs, tickets, audits and design notes go in `specs/`
(`specs/slices/` for slice specs, `specs/audits/`, `specs/notes/`).

- `docs/developer/coding-standards.md`: the code standard and the limits the linters enforce. Read it before writing code.
- `docs/developer/testing.md`: where tests live, the fakes, and the coverage bar, and how to run them.
- `docs/developer/ci-release.md`: the CI pipeline, the release filter, versions and `Release:` trailers, signing.
- `docs/developer/launch-contract.md`: how the app starts Claude, and what a launcher (the Podman wrapper) must provide.
- `docs/developer/adding-a-tab.md`: the tab registry, and the three places a new tab touches.
- `docs/developer/security.md`: the threat model, the isolation boundary, what Assay guarantees, and the accepted risks.
  Read it before changing a hook, a tool, an IPC handler, the updater or CI.

## Where things are

- `src/core`: pure logic with tests (runs, root notes, threads, search, keymap, tabs, theme).
- `src/main`: Electron main; all file access (`files.ts`, `browse.ts`) and IPC (`ipc.ts`). The renderer never reads a
  path itself; `src/shared/ipc.ts` is the only contract between the two.
- `src/renderer`: React UI. `terminal.ts` is the only file that imports `ghostty-web`. `tabs/` holds one component per tab.
- `src/server`: the MCP server `assay`, one per Claude session, declared by the app with `--mcp-config`
  (docs/developer/launch-contract.md). Claude's tools are `mcp__assay__<tool>`: `sql`, `python`, `trusted`, `park`,
  `close`, `focus`, `order`, `note`, `revise_note`, `link_notes`, `note_labels`. It owns the kernel
  (`python/analysis_kernel.py serve`), started with the server and ended with it.
- `src/hooks`: UserPromptSubmit (the rules on each typed prompt, the trusted calculations, the user's runs since the
  last prompt), PreToolUse on Bash (no Python through Bash) and on Write/Edit/MultiEdit/NotebookEdit (nothing into
  `$ASSAY_ROOT/trusted`, `dictionaries`, `notes` or `.git`, the analysis's `.assay/` or `queries/`, Assay's backend
  or venv, nor into another analysis). `plugin/skills`:
  - `assay:resume`: report where the analysis stands and offer past root notes to link.
  - `assay:wrap-up`: close threads, write findings as root notes, settle weak citations, link the notes read.
  - `assay:propose-trusted`: draft a trusted calculation or dictionary entry, with every file Check needs.
- `python/`: `analysis_db`, `analysis_kernel`, `analysis_sql` (the SQL rules on Claude's `sql`
  calls and on SQL templates at Check, and the lineage and step queries the Steps tab draws and runs; specs/slices/slice-9.md;
  its docstring names the modules behind it),
  and `analysis_trust` (the trust command line; its docstring names the modules behind it), built by the app into
  Assay's venv (`src/main/backend.ts`). A new `analysis_*.py` module goes in `py-modules` in `python/pyproject.toml`.
- The app talks to the server through files: it writes `.assay/requests/<id>.json` (`sql`, `python`, `interrupt`,
  `restart`, `replay`, `lineage`, `steps`, `trust-list`, `trust-check`, `trust-done`), the server answers in
  `.assay/replies/`, writes next to a SQL run in `queries/` when the Steps tab asks (`NNN.lineage.json`;
  `NNN.steps.json` and each step's `NNN.k_<name>.sql`, `.csv` and `.counts.sql`: steps are not runs and take no
  number, and `q(N, step=k)` in the kernel loads step k's rows), and
  writes `.assay/runs.json` and `.assay/trust/<name>.json` for run status and the trust review. For the prompt hook
  only, it writes `.assay/user-runs.json` (the user's runs) and `.assay/step-notices.json` (step checks that failed),
  both emptied by the hook, and `.assay/session.json` (the kernel's python). No tool of Claude's can start or answer a review: only the Trust tab's buttons do, and only the app writes the trust ledger (`ASSAY_LEDGER`, specs/trust-ledger.md); `trust-done` carries no power.

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

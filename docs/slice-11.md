# Slice 11 spec: process, gates, backend in the app, CI/CD, auto-update, tab settings, audit

Status: 11a and 11b built, 2026-11-10. 11c built and released: v0.1.0, signed with the Developer ID and notarized, 2026-11-11 (docs/process/ci-release.md). 11d built, 2026-11-11; its manual test on the Mac is still to run. 11e built, 2026-11-11; not yet tried in the running app. 11f in progress: `analysis_trust.py` done, 2026-11-11. Written from the grilling session of 2026-11-10, after reading Assay's
code.

Seven slices, built in this order. Each ships, with CI green, before the next one starts:

1. **11a, process and gates** (about 1 day): AGENTS.md and the process docs, Clean Code as the standard, ESLint and
   ruff, 90% coverage, all enforced against a baseline that can only shrink, and a pre-push check.
2. **11b, backend in the app** (1 to 2 days): the app ships the plugin, the server, the hooks and the Python project,
   builds the venv with uv, and starts plain Claude Code. Podman becomes one launcher among others, outside Assay.
3. **11c, CI and release** (1 to 2 days): every push to main runs unit and integration tests on Linux, then builds,
   signs and publishes a release on macOS.
4. **11d, auto-update** (about 1 day): the app downloads each release in the background and offers a restart.
5. **11e, tab and strip settings** (1 to 2 days): tabs become modules in one registry; Settings turns each on or off,
   orders them, and configures the analysis strip.
6. **11f, clean-code burn-down** (3 to 5 days): refactor until every baseline is empty.
7. **11g, security audit** (1 day, then 1 to 2 days of fixes): Codex audits against four threats; the holes are
   plugged.

Build each slice in its own session with the `tdd` skill. Codex reviews each slice (the `code-review` skill, run by a
`delegate:codex` subagent) before the user pushes it.

## Problem Statement

Assay has grown slice by slice with tests but no lint, no coverage figure, no CI and no releases. Installing a change
means `npm run install-app` on the Mac, and the backend runs from the `~/Code/assay` checkout that the user's Podman
wrapper mounts, with a Python venv that `claude-pkg venv-assay` builds. Three things must stay on one version (the
app, the checkout and the venv), two repos are involved, and Assay cannot run with plain Claude Code at all. The tabs
are hard-wired across `Workspace.tsx`, `DataPane.tsx`, `common.tsx`, `keymap.ts` and `dataTabs.ts`, so adding,
removing or hiding one touches five files. The process each session should follow lives in nobody's instructions.

## Decisions settled with the user (2026-11-10)

Process and quality:

- **Standard:** Uncle Bob's Clean Code, except that comments explaining *why* stay, and deep modules that hide
  complexity stay. Where Clean Code and those two clash, the comment and the deep module win.
- **Smell gate:** ESLint (typescript-eslint strict plus eslint-plugin-sonarjs) and ruff, run locally and in CI, failing
  on any warning. No hosted service.
- **Limits:** functions up to 40 lines, up to 4 parameters (an options object counts as one), cognitive complexity up
  to 15, files up to 400 lines, no duplicated blocks. Lines count without blanks or comments, JSX included.
- **Coverage:** 90% of lines and branches in `src/core`, `src/server`, `src/hooks` and `python/`. React components
  and Electron main are not measured; their logic moves into `src/core`.
- **Rollout:** a committed baseline of today's violations and per-file coverage. Any new violation fails; no file may
  get worse; new files start at the full bar. 11f shrinks the baselines to empty.
- **Integration tests:** the MCP server with a real Python kernel and the hooks on real files, plus an Electron smoke
  test driven by Playwright with a stub Claude and a fake `databricks` CLI. Both run on Linux.
- **Process docs:** `AGENTS.md` holds the rules every session follows and links `docs/process/*.md`. `CLAUDE.md` is
  the single line `@AGENTS.md`. The README keeps what a human needs.

Flow, CI and release:

- **No PRs.** The user pushes straight to main; Claude commits on its session branch, which reaches main through the
  user. Pull requests, when opened, also get the unit tests.
- **Pipeline:** each push to main runs unit tests, then integration tests (both on Linux), then the release on
  macOS. The release runs only when both passed and the push changed more than docs, tests or CI config. Pushes to
  other branches run unit and integration tests. Locally, `npm run check` runs as a git pre-push hook, and Claude runs
  it before every commit.
- **Versioning:** every release bumps the patch number. A `Release: minor` or `Release: major` trailer in any commit
  since the last release bumps more. CI tags the commit and writes the version into the build only; no bump commit.
- **Signing:** a self-signed certificate now. An Apple Developer ID may follow in about a month; the switch costs one
  manual reinstall, because an installed self-signed app refuses an update signed by another identity.
- **Repo:** `tejas-kale/assay`, private. Claude's tokens in the user's sandbox cannot see it, so CI results reach
  Claude only when the user pastes them.

Backend and launch:

- **Assay works with plain Claude Code.** The user's Podman setup is managed separately, in the config repo, as a
  launcher that honours the launch contract (below).
- **The app ships the backend** (plugin, server and hook bundles, Python project) and copies it, per version, under
  `~/Library/Application Support/Assay/`. It builds the venv with uv and passes its path in `ASSAY_VENV`.
- **Runtime tools** come from the user's PATH: node 22 or later, uv, databricks. Settings shows a Doctor list of what
  is missing. Nothing is bundled.
- **The plugin loads with `--plugin-dir`** on each launch, so only sessions Assay starts see it.
- **Isolation is the launcher's job.** Assay enforces its own rules (hooks, tools, IPC, updater). Containing code
  execution belongs to the launcher (the Podman wrapper, or Claude Code's sandbox), and the docs say so.
- **Postgres only under a launcher that provides `rds-psql`.** Elsewhere a Postgres run fails with a clear message.

Updates:

- **Ask, then restart.** The app checks at launch and hourly and downloads in the background. A banner offers
  `Restart`; otherwise the update installs when the user quits. The same analyses reopen, each with a fresh Claude
  session.
- **Credentials:** a fine-grained GitHub token, limited to `tejas-kale/assay` with Contents read-only, pasted once in
  Settings and kept in the Keychain through Electron's `safeStorage`.

Tabs and strip:

- **Tabs:** each tab on or off, and its order within its pane. The settings apply to the whole app.
- **A tab that is off** shows no badge. Search skips its hits. Its shortcut, and anything that would reveal it, shows a
  toast instead: `Trust tab is off: Settings (⌘,)`. A pane whose tabs are all off is hidden, and the terminal widens.
- **Strip:** position (bottom or left, moved from the palette into Settings; the palette command stays), what each
  entry shows (title, Claude state, run in progress, number), and auto-hide while only one analysis is open.
- **Modularity:** one module per tab and one registry, read by the panes, keymap, palette and Settings. No runtime
  plugins and no configurable pane layout.

Security:

- **Threats in scope:** prompt injection through data (query results, files, notes) steering Claude past Assay's
  rules; tampered updates; malicious npm or PyPI dependencies; hostile HTML, Markdown or Mermaid reaching IPC.
- **Done when** every critical, high and medium finding is fixed, and each low is fixed or listed with its reason in
  `docs/process/security.md`.

## Slice 11a: process and gates

### Process docs

Load the `writing-for-agents` skill before writing these.

- `AGENTS.md`, short. It holds:
  - the one rule from the README: one place where code runs, and every run is recorded;
  - the session flow: commit on the session branch; never push; run `npm run check` before every commit and fix
    what it reports; never add to a baseline; write commit subjects for the release notes (what changed for the user);
    add a `Release: minor` or `Release: major` trailer when a change warrants it;
  - "Where things are" and "Driving the app without a person", moved from the README;
  - a link to each `docs/process/*.md`, each added by the slice that writes it.
- `CLAUDE.md`: the single line `@AGENTS.md`.
- `docs/process/coding-standards.md`: the Clean Code rules adopted (intention-revealing names, one responsibility per
  function and module, small functions, few arguments, no flag arguments, no dead or commented-out code,
  command/query separation, errors as values or exceptions but not both in one module), the two exceptions (why
  comments, deep modules), the limits above, and which linter rule enforces each.
- `docs/process/testing.md`: unit and integration tests, where each lives, the fakes, the coverage bar, how the
  baselines work, and how to run everything.
- `README.md` keeps install, environment, keys and features for a human.

### Lint

- `eslint.config.js` (flat config) with typescript-eslint `strictTypeChecked`, eslint-plugin-sonarjs's recommended
  rules, and: `max-lines-per-function` 40 (skipping blanks and comments), `max-params` 4,
  `sonarjs/cognitive-complexity` 15, `max-lines` 400 (skipping blanks and comments),
  `sonarjs/no-identical-functions`. It lints `src`, `scripts` and `tests`.
- The baseline is ESLint's bulk suppressions (ESLint 9.24 or later): `eslint --suppress-all` writes
  `eslint-suppressions.json` once. A new violation fails; when a count falls, `eslint --prune-suppressions` shrinks the
  file, and the check fails until it is pruned, so the file always states the truth.
- `python/pyproject.toml` gains `[tool.ruff]`: rule sets `E`, `F`, `W`, `I`, `B`, `C90` (max complexity 15), `PL`
  (`max-args` 4, `max-statements` 40), `SIM`, `RUF`, `UP`, `N`; line length as today's code.
- Ruff has no baseline, so `scripts/ratchet.ts` keeps `python/ruff-baseline.json`: violation counts per file and
  rule from `ruff check --output-format json`. It fails when a count grows or a new pair appears, and with
  `--update` writes the smaller counts back. The check fails while the file holds counts higher than today's.

### Coverage

- `npm test` runs `node --test --experimental-test-coverage --test-reporter=lcov` and, for Python,
  `pytest --cov --cov-branch --cov-report=json` in `python/`.
- `scripts/ratchet.ts` also keeps `coverage-baseline.json`: per file in scope, line and branch percentages. A file
  in the baseline may not drop below its figures; a file not in it must reach 90% on both; a file reaching 90% leaves
  the baseline. As with lint, a baseline the code has beaten fails the check until `npm run ratchet -- --update`
  writes the better figures, so no file can slide back to an old low.
- `src/renderer` and `src/main` are outside the bar. When a component holds a decision worth testing, the decision
  moves into `src/core`, as `dataTabs.ts` and `stepsRequests.ts` already do.

### The check

- `npm run check`: typecheck, ESLint, unit tests with coverage, ruff, pytest with coverage, then the ratchet. Under
  about a minute on the Mac.
- A pre-push hook in `.githooks/pre-push` runs it. `scripts/postinstall.mjs` sets `git config core.hooksPath
  .githooks` (no new package). `git push --no-verify` skips it; CI still runs the same checks.

### User steps

- `sandbox-pkg npm install -D eslint @eslint/js typescript-eslint eslint-plugin-sonarjs` (plus
  `eslint-plugin-react-hooks` for the renderer).
- Add `ruff` and `pytest-cov` to `python/pyproject.toml`'s dev dependencies and lock them (`uv lock`).

### Tests

- `scripts/ratchet.test.ts`: a grown count fails; a new file below 90% fails; a file at 90% leaves the baseline; a
  smaller count passes and `--update` writes it; an untouched baseline passes.
- `npm run check` passes on the commit that adds the baselines.

## Slice 11b: backend in the app

### What the app ships

electron-builder's `extraResources` copies into `Contents/Resources/backend/`:

```
backend/
  plugin/        .claude-plugin/, hooks/hooks.json, skills/
  out/server/    index.mjs
  out/hooks/     prompt.mjs, bash.mjs, write.mjs, state.mjs
  python/        analysis_*.py, pyproject.toml, uv.lock   (no tests/, no __pycache__, no *.egg-info)
```

The layout matches the repo, so the plugin's `${CLAUDE_PLUGIN_ROOT}/../out/...` paths and the server's
`../../python/analysis_kernel.py` keep working unchanged.

### Install per version

`src/main/backend.ts` (new), at launch, before any analysis starts Claude:

1. If `~/Library/Application Support/Assay/backend/<version>/` is missing, copy `Resources/backend/` to a temporary
   folder beside it and rename it into place.
2. If `~/Library/Application Support/Assay/venvs/<version>/` is missing, run
   `uv sync --frozen --no-editable --project <backend>/python` with `UV_PROJECT_ENVIRONMENT` set to it, through the
   user's login shell (as the Claude launch does, to find uv). The venv is per version, not per `uv.lock` hash: the
   project installs into it non-editable, so each version's venv holds that version's helpers. uv's cache makes an
   unchanged lock install in seconds.
3. Delete backend and venv folders of versions other than this one and the one before it.
4. Write progress to the state the renderer shows: `Preparing Assay 0.4.3: Python environment...`. Claude starts
   while the venv builds; a Python tool called before it is ready answers that it is still building. If the build
   fails, the Doctor shows the error, Python tools return it, and SQL still runs.

Unpackaged (`npm run dev`): the backend folder is the repo itself (after `npm run build:server`), and the venv is
`venvs/dev/`, built editable from `python/`, so edits to the helpers apply at once.

### The launch contract

Written to `docs/process/launch-contract.md`, the only description a launcher needs. The app runs, through the user's
login shell, `exec "${ASSAY_CLAUDE_BIN:-claude}" --plugin-dir "$ASSAY_BACKEND/plugin"` in the root, with:

| Variable | Value |
|---|---|
| `ASSAY_APP` | `1` |
| `ASSAY_ROOT` | the Settings folder (holds `analyses/`, `dictionaries/`, `trusted/`) |
| `ASSAY_ANALYSIS` | the open analysis's folder |
| `ASSAY_BACKEND` | `~/Library/Application Support/Assay/backend/<version>` |
| `ASSAY_VENV` | `~/Library/Application Support/Assay/venvs/<version>` |
| `ASSAY_THEME` | Claude Code's theme, as today |

A launcher that runs Claude elsewhere (a container, a VM) must:

- make `ASSAY_ROOT`, `ASSAY_ANALYSIS` and `ASSAY_BACKEND` valid at the **same absolute paths** (they contain a space:
  `Application Support`), with `ASSAY_BACKEND` read-only;
- provide `node` 22 or later and `databricks`, plus `rds-psql` if Postgres runs are wanted;
- replace `ASSAY_VENV` with a venv valid where Claude runs, built from `$ASSAY_BACKEND/python` with
  `uv sync --frozen --no-editable` (the Mac venv holds macOS binaries).

The user updates the Podman wrapper in the config repo to this contract; this slice does not touch that repo.

### Code changes

- `src/core/session.ts`: `PLUGIN_DIR` goes. `spawnSpec` takes the backend and venv paths, sets `ASSAY_BACKEND` and
  `ASSAY_VENV`, and builds the command above.
- `src/core/rules.ts`: `VENV_ASSAY` (`/opt/venv-assay`) and `claude-pkg venv-assay` go. The rule becomes: "If a
  package is missing, add it to `python/pyproject.toml` in the Assay repo, lock it, and tell the user; the next Assay
  release builds it. Never a Bash pip install and never another venv." `VENV_ASSAY_HINT` becomes "Assay is still
  building its Python environment" or the build error.
- `src/server/main.ts`: `ASSAY_VENV` is required; without it, every tool answers that Assay did not start the
  session (as `NOT_ASSAY` does now).
- `src/server/assay.ts`: when `rds-psql` is not on PATH, a Postgres run fails with: `Postgres runs need a launcher
  that provides rds-psql (docs/process/launch-contract.md).`
- `src/core/doctor.ts` (new, pure): from the outputs of `command -v` and `--version` for `claude` (or
  `$ASSAY_CLAUDE_BIN`), `node`, `uv`, `databricks` and `rds-psql`, plus the venv state, a list of checks:
  `ok` / `missing` / `too old` / `optional`, each with its fix (`brew install node`, `brew install uv`,
  `brew install databricks/tap/databricks`). Node below 22 is too old; `rds-psql` is optional.
- `src/main/doctor.ts`: runs those through the login shell at launch and on demand.
- Settings gains a **Doctor** section: the list, a Recheck button, and the venv's state. Only a missing `claude`
  blocks opening an analysis.
- `README.md`: install and environment rewritten for the new layout. The config-repo section shrinks to a pointer to
  the launch contract.

### Tests

- `src/core/session.test.ts`: the spec's command and env carry the backend and venv paths; a path with a space is
  quoted; `ELECTRON_RUN_AS_NODE` is still dropped.
- `src/core/doctor.test.ts`: node 20 too old, node 22 ok, a missing uv with its fix, `rds-psql` missing is optional,
  a failed venv build is reported.
- `src/main` with a temp folder: install copies once and renames atomically; a second launch is a no-op; old versions
  are pruned and the previous one is kept.
- `src/server`: without `ASSAY_VENV`, tools answer that Assay did not start the session; a Postgres run without
  `rds-psql` gives the contract message.

## Slice 11c: CI and release

### Workflow

`.github/workflows/ci.yml`, with every action pinned by commit SHA:

```
on: push (any branch), pull_request
  unit         ubuntu-latest   typecheck, ESLint, node unit tests + coverage,
                               uv sync, ruff, pytest + coverage, ratchet         (~3 min)
  integration  ubuntu-latest   on push only; needs unit                          (~8 min)
  release      macos-latest    push to main only; needs unit and integration;
                               skipped when the push changed only docs/**,
                               **/*.md, *.test.ts, python/tests/**, tests/**,
                               .github/**                                        (~12 min)
```

- Node from `.node-version` (22, the lowest supported); Python and dependencies from `uv sync --frozen`.
- `concurrency: release` keeps one release at a time, so two quick pushes cannot both claim a version.
- The paths check is plain `git diff --name-only <before>..<sha>` in a step, not a third-party action.
- Macos minutes on a private repo count 10x; the filter keeps a docs-only push from costing about 120 of them.

### Integration tests

They live in `tests/integration/` (outside `npm test`'s `src/**/*.test.ts`) and run with
`npm run test:integration`.

- **Backend** (`tests/integration/backend.test.ts`): builds a venv with `python/tests/test_venv.sh`, starts the MCP
  server through the MCP SDK's client with a scratch root and analysis, and exercises: a SQL run (claims a number,
  writes the run files, `runs.json`), a Python run in the real kernel with `q(N)`, a Steps request through
  `.assay/requests/`, `trusted` and the include expansion, and each hook on real files (the Bash guard, the write
  guard on `trusted/`, the prompt hook's injected rules). The real-kernel parts of `src/server/python.test.ts` move
  here.
- **App smoke** (`tests/integration/app.test.ts`): `electron-vite build`, then `playwright-core`'s `_electron`
  launches the built app under `xvfb-run`, with a scratch user data folder whose `settings.json` names a scratch root.
  `ASSAY_CLAUDE_BIN` points to `tests/integration/fixtures/stub-claude.mjs`, which starts the real MCP server
  through the SDK client and keeps it open, as Claude would. The test opens the analysis, runs SQL from the Code tab
  with Cmd+Enter, and checks that Data shows the rows, History lists the run and Steps draws it.
- **Fakes:** `tests/integration/fixtures/bin/databricks` answers `experimental aitools tools query` with canned JSON
  chosen by the SQL's text; it is first on PATH. No test reaches Databricks, Postgres or a real Claude.
- node-pty is rebuilt for Electron on Linux with `@electron/rebuild` in the job (the postinstall does it only on
  the Mac).
- `tsconfig.json`'s `include` gains `tests`.

### Release

- **Version:** the latest `v*` tag (none yet: `package.json`'s 0.1.0 is the first), bumped by patch, or by the
  largest `Release:` trailer among the commits since that tag. `scripts/next-version.ts` computes it (pure function
  plus a thin git wrapper); CI runs `npm version --no-git-tag-version <v>` on the runner only.
- **Build:** `electron-builder --mac dmg zip --arm64 --publish always`. The DMG is for a first install; the zip and
  `latest-mac.yml` are what the updater reads. Hardened runtime goes on now, with `resources/entitlements.mac.plist`
  (`allow-jit`, `allow-unsigned-executable-memory`; `disable-library-validation` only if node-pty will not load under
  the self-signed identity, and it goes with the Developer ID).
- **Fuses**, through electron-builder's `electronFuses`: `runAsNode` off, `enableNodeOptionsEnvironmentVariable` off,
  `enableNodeCliInspectArguments` off, `enableEmbeddedAsarIntegrityValidation` on, `onlyLoadAppFromAsar` on.
- **Signing:** `CSC_LINK` (the base64 .p12) and `CSC_KEY_PASSWORD` from repository secrets. The Developer ID later
  changes only these secrets, plus notarization secrets.
- **Publish:** the job tags `v<version>` on the commit and creates the GitHub release with the DMG, the zip,
  `latest-mac.yml` and notes: the commit subjects since the last tag.
- `package.json`'s `build` gains `publish: { provider: github, owner: tejas-kale, repo: assay, private: true }`;
  `mac.target` becomes `dmg` and `zip`, and `identity: "-"` goes.

### Process doc

`docs/process/ci-release.md`: the pipeline, the filter, versioning and trailers, signing, the secrets, the cert switch
(install the first Developer ID build by hand once), and what to do when main is red (fix forward; nothing ships
until it is green).

### User steps (a `wizard` script walks them)

- `sandbox-pkg npm install -D playwright-core`.
- Make a self-signed code-signing certificate in Keychain Access, export it as .p12, and add `CSC_LINK` and
  `CSC_KEY_PASSWORD` to the repository's secrets (about 15 minutes).
- Install the first release from its DMG, and allow it once in System Settings > Privacy & Security.

### Tests

- `scripts/next-version.test.ts`: no tag gives 0.1.0; a patch bump; a minor trailer resets the patch; a major trailer
  wins over a minor; a trailer before the last tag is ignored.
- The paths filter as a pure function with tests: docs-only skips; one `src/` file releases.
- The workflow itself is verified by its first runs; `docs/process/ci-release.md` records the first green release.

## Slice 11d: auto-update

- `electron-updater` in main, packaged builds only (user step: `sandbox-pkg npm install electron-updater`).
- **Token:** Settings > Updates takes the fine-grained token. Main encrypts it with `safeStorage` into
  `userData/update-token.bin`. The renderer only ever learns whether a token is set. The token goes in the updater's
  request headers. Without one the updater is off, and Settings says so.
- **Checks:** 10 seconds after launch, then hourly. `autoDownload` on, `autoInstallOnAppQuit` on.
- **Ready:** every analysis view shows a banner, `Assay 0.4.3 is ready. Restart`, and the palette gains `Restart to
  update`. `Restart` closes each analysis's Claude through the existing close flow (which waits for a launcher's
  exit), saves the open set, and calls `quitAndInstall`. At relaunch, `open-analyses.json` reopens the same analyses,
  each with a new Claude session. Kernel state is gone; runs are on disk.
- **Errors** do not interrupt: Settings > Updates shows the current version, the last check, and the last error.
- `src/core/update.ts` (new, pure): the states (`off`, `idle`, `checking`, `downloading`, `ready`, `error`), the
  transitions from updater events, the banner and Settings text, and the next check time. `src/main/update.ts` wires
  electron-updater to it.

### Tests

- `src/core/update.test.ts`: no token means off; a download leads to ready with the version in the banner; an error
  keeps the previous ready state; the next check is an hour after the last; a check while downloading is skipped.
- Manual, on the Mac, recorded in `docs/process/ci-release.md`: release N installed, push a change, release N+1
  appears, the banner shows, Restart reopens the same analyses.

## Slice 11e: tab and strip settings

### The registry

- `src/core/tabs.ts` (pure, used by main and renderer): one entry per tab:
  `{ id, title, pane: 'notes' | 'data', shortcut: KeyCode, marker?: (before: Seen, after: Seen) => boolean }`, in
  default order. `TabId` is derived from it, replacing `NotesTabName` and `DataTabName`. The new-content rules in
  `dataTabs.ts` move into each entry's `marker`.
- `src/renderer/tabs/<id>.tsx`: one component per tab, with a shared props type. `src/renderer/tabs/index.ts` maps
  every `TabId` to its component as a `Record<TabId, ...>`, so a tab without a component fails the typecheck.
- `keymap.ts` builds the `tab.*` commands from the registry. The palette, the `Ctrl+2` / `Ctrl+3` cycling, the panes'
  tab bars and Settings all read the registry with the user's settings applied.
- Adding a tab: one registry entry, one component file, one line in the map. `docs/process/adding-a-tab.md` says
  so, with a worked example.

### Settings

- `settings.json` gains:

  ```json
  {
    "tabs": { "notes": [{ "id": "overview", "on": true }], "data": [{ "id": "data", "on": true }] },
    "strip": { "side": "bottom", "show": { "title": true, "state": true, "run": true, "number": false }, "autoHide": false }
  }
  ```

  `parseSettings` fills defaults, drops unknown ids, and appends a tab missing from the file (one added in a later
  version) at the end of its pane, turned on. `strip.json`'s side moves into `settings.json` once and the old file is
  deleted.
- The Settings dialog gains **Tabs** (two lists, one per pane: a checkbox per tab, and move up or down with buttons or
  `Alt+↑` / `Alt+↓`) and **Strip** (side, the four show toggles, auto-hide). Changes apply at once to every analysis.

### A tab that is off

- It is not in its pane's tab bar and gets no marker.
- Its shortcut and palette command show the toast `<Title> tab is off: Settings (⌘,)`. So does a reveal aimed at it:
  a search hit, a followed citation, a trust review waiting.
- Universal search drops hits that only an off tab can show.
- A pane with every tab off is hidden, and the terminal takes its width. `Ctrl+2` or `Ctrl+3` for a hidden pane shows
  the same kind of toast.

### The strip

- `src/core/strip.ts`'s `stripEntry` takes the `show` settings. Auto-hide hides the strip view while the open set
  holds one analysis. The palette's Move analysis strip keeps working and writes `strip.side`.

### Tests

- `src/core/tabs.test.ts`: every tab has a unique id and shortcut; default order; `marker` rules as in today's
  `dataTabs.test.ts`.
- `src/core/settings.test.ts`: defaults; an unknown tab id dropped; a new tab appended and on; order kept; a
  malformed file gives the defaults; the old `strip.json` migrates.
- `src/core/keymap.test.ts`: an off tab's command resolves to the toast; no two tabs share a shortcut.
- Pure helpers for the visible tabs of a pane, the next tab on `Ctrl+2` cycling past off tabs, and whether a pane is
  hidden, each with tests.

## Slice 11f: clean-code burn-down

- Work from the biggest offenders down, one or two files per session: `analysis_trust.py` (1,227 lines),
  `DataPane.tsx` (1,107), `analysis_sql.py` (988), `assay.ts` (850), `windows.ts` (632), `analysis_kernel.py` (569),
  `files.ts` (547), then the rest of `eslint-suppressions.json` and `python/ruff-baseline.json`.
- For each: raise its coverage to 90% first (tests pin today's behaviour), then refactor under green tests, prune
  the suppressions, and update the baselines. Behaviour does not change; a refactor that needs a behaviour change
  stops and asks.
- Codex reviews each session's commits against `docs/process/coding-standards.md`.
- Done when `eslint-suppressions.json`, `python/ruff-baseline.json` and `coverage-baseline.json` are empty and
  deleted, and the ratchet then requires the full bar everywhere.
- Progress: `analysis_trust.py` (2026-11-11) is now the command line only, over `analysis_calc`, `analysis_dictionary`,
  `analysis_library`, `analysis_runner`, `analysis_fixtures`, `analysis_pytest`, `analysis_blocks` and
  `analysis_review`. `list` and `dictionary` still load neither SQLAlchemy nor DuckDB; `analysis_trust.fixture_engine`
  still works for a calculation's own tests. `Problem` is now `TrustError` and `Mismatch` `MismatchError` (ruff's
  N818); only a failing run's pytest summary line shows the new names. Next: `DataPane.tsx`.

## Slice 11g: security audit

- A `delegate:codex` agent audits the whole repo against the four threats, with these starting points:
  - **Prompt injection:** the hooks' guards (Bash, Write/Edit/NotebookEdit, other analyses, `trusted/`,
    `dictionaries/`); MCP tool arguments (paths, slugs, run numbers); the rule that only the Trust tab's buttons start
    or answer a review; what reaches Claude from query results, notes and files.
  - **Tampered updates:** the updater's trust chain (code signature, `latest-mac.yml` hashes, HTTPS, token scope);
    who can trigger a release and reach the signing secrets.
  - **Dependencies:** lockfiles, install scripts, pinned actions, `npm audit` and `pip-audit` results.
  - **Hostile content in the UI:** Markdown, Mermaid and HTML rendering; CSP; `will-navigate`, `setWindowOpenHandler`
    and `openExternal`; every IPC handler's argument checks and path resolution (`safePath.ts`, `files.ts`,
    `browse.ts`); the fuses.
- Findings go to `docs/security-audit-2026-11.md` (id, threat, severity, where, fix), not GitHub issues: Claude's
  tokens cannot reach the repo. Each fix commit names its finding id and adds a regression test.
- CI gains `npm audit --audit-level=high`, `pip-audit` on the locked Python dependencies, and a fuse check on the
  built app (`@electron/fuses read`) in the release job.
- `docs/process/security.md`: the threat model, the isolation boundary (the launcher's job), the rules Assay
  guarantees, and the accepted lows with reasons.
- Done when every critical, high and medium finding is fixed with its test, and each low is fixed or accepted in
  `docs/process/security.md`.

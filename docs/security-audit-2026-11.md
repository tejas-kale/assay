# Security audit, November 2026 (slice 11g)

Four read-only auditors went through the whole repo on 2026-11-12, one per threat in docs/slice-11.md. Codex was not
available in the session, so Claude subagents did the audit; Claude checked each finding against the code before
fixing it. The threat model, the isolation boundary and the accepted lows are in `docs/process/security.md`.

Severity is this document's own: what the finding lets an attacker do to Assay's rules or the user's Mac, given the
boundary in `docs/process/security.md`. Each fix commit names its finding ids and adds a regression test.

Threats: **PI** prompt injection through data, **UP** tampered updates (and the release pipeline), **DEP** malicious
dependencies, **UI** hostile content reaching the renderer and IPC.

A second, independent audit (GPT through Copilot, read-only) checked these findings on 2026-11-12. It confirmed the
three open ones, found the fixes for PI-3, PI-4, PI-5, PI-6, UI-5, UI-6 and UP-1 incomplete, and found PI-8, PI-9
and PI-10. Reopened findings keep their id and are listed under Open until fixed again. The fixes were then reviewed again
by the same model; the gaps it found in PI-6, PI-10 and UP-1 are closed in the rows below; PI-5 stays open.

## Open

| Id | Severity | Where | Finding | Next step |
|---|---|---|---|---|
| PI-1 | Critical | `src/server/requests.ts`, `src/server/trustPromote.ts` | The server does whatever a file in `.assay/requests/` says, `trust-answer` included, and nothing tells the app's file from one Claude's code wrote. A Write into `.assay/` is now refused (below), but the kernel and Bash still run as the user and can write the file: an injected Claude can check and approve its own calculation. | The app answers the review itself, on the host, and the request channel loses `trust-answer`; trust then rests on something only the app writes, mounted read-only where Claude runs. Needs the user's choice of design (security.md, "Open decisions"). |
| PI-2 | High | `python/analysis_library.py` (`dirty`), `src/hooks/decide.ts` | A calculation is trusted when it is committed in the root's git. Bash or the kernel can copy a file into `trusted/` and commit it. The Write guard now refuses `.git/`, but a shell or Python cannot be stopped by a hook. | The same remedy as PI-1. |
| PI-8 | High | `python/analysis_calc.py`, `src/core/calculations.ts`, `src/server/trustStream.ts`, `src/server/trustPromote.ts` | Check imports the proposal into the helper process, so the proposal can print a `done` event with `ok: true` and its own file list; approval then writes those names, `../` included, outside `trusted/`. | Run the proposal apart from the process that reports the outcome; derive the file names to promote, and keep them inside the destination. |
| PI-5 | Medium | `src/core/bashGuard.ts` | Reopened twice. Three rounds closed combined options, redirections, here-strings, `env -S`, substitutions in scripts and deep nesting, but a third review still ran Python through `setsid`, `chrt`, `ionice`, a function, an alias, `bash <<EOF`, a line continuation and `${v:- #$(...)}`; it also found four false positives. | Decision pending: accept the rest under L-1, parse with a real Bash grammar, or keep Python off the PATH of Claude's Bash in the launcher. |
| PI-4 | Low | `src/core/rules.ts` | Reopened: the analysis title still reaches the prompt's instructions as text, so a crafted title reads as an instruction. | Frame it as data. |

## Fixed

| Id | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| PI-9 | High | `src/server/assay.ts`, `src/server/trustStream.ts`, `src/hooks/decide.ts` | Helpers run `python -m analysis_trust` from the analysis folder, so an `analysis_trust.py` there replaces the helper: Check, the listings and the prompt's trusted context. | Every helper runs `python -I -B -m` (`src/core/helperFlags.ts`), so the analysis folder is not on the path. L-7 now covers only the kernel. |
| UI-3 | Medium | `src/main/windowPages.ts` (`loadFile`), fuse `grantFileProtocolExtraPrivileges` | The renderer is a `file://` page, so the policy's `'self'` admits any `file:` URL and the page keeps file's extra privileges. After a sanitiser bypass, a script Claude wrote into an analysis could load. | Fixed in code, not yet run on a Mac: the packaged renderer loads from `app://assay`, whose handler (`src/core/appProtocol.ts`, `src/main/appScheme.ts`) serves only real paths inside the renderer folder; the `grantFileProtocolExtraPrivileges` fuse is off. |
| PI-6 | Medium | `src/hooks/decide.ts` | Reopened: the protected folders (`trusted/`, `notes/`, `.assay/`, `queries/`) are compared by name, so a symlinked protected folder, or its destination, takes Writes. | Paths resolve link by link before each `..`; every protected folder is checked by name, by real path, and with the real path mapped back to its name. |
| PI-10 | Medium | `python/analysis_review.py`, `src/server/trustPromote.ts` | Only the main file is snapshotted for Check; a test, `.test.yaml` or `.rebuild.sql` changed after Check is approved and committed unchecked. | Check reads each proposal file once into a private copy; every step, the code shown and the approved bytes come from it. Approval writes only the proposal's own file names, inside the destination, or nothing. |
| UI-5 | Medium | `src/core/settings.ts`, `src/main/settings.ts` | Reopened: the home-folder check compares text, so `/Users/ME` on a case-insensitive disk, or a symlink to home, passes, and the alias is saved. | `resolveRoot` (`src/main/rootPath.ts`) compares the real paths of the root and home, ignoring case, and saves the real path. |
| UP-1 | Medium | `src/main/backend.ts` | Reopened: the backend's stamp skips symlinks, so a linked `python/__pycache__` with matching headers survives the check and its bytecode runs. | The stamp hashes every file, link and folder, so any addition replaces the copy; caches are not shipped or copied; Assay's Python children run with `PYTHONDONTWRITEBYTECODE=1`, and the helpers with `-B`. |
| UI-6 | Low | `src/main/noteFiles.ts` | Reopened: search and the note list read linked notes through `readHead`. | One plain-file reader (`lstat`, regular files, `O_NOFOLLOW`) serves listing, search, parsing and direct reads. |
| PI-3 | High | `src/server/sqlRun.ts`, `src/core/runs.ts`, `src/core/calculations.ts` | Claude's SQL or Python could start with `-- author: user` or `-- trusted: <name>`, and the run was shown as the user's, or a citation of it labelled trusted. `queries/` could be edited with Write. | The server drops header-shaped lines from the leading comments of Claude's code (`withoutHeaderLines`); a trusted header is read from the leading comment lines only; the Write guard refuses `queries/`. Reopened by the second audit: a blank or indented line before the forged header stopped the stripping, and saving trimmed it back to the top. The code is now trimmed as a run saves it and stripped until nothing changes. |
| PI-4 | Medium | `src/hooks/decide.ts`, `src/core/rules.ts` | `.assay/user-runs.json`, `step-notices.json` and the analysis title went into the prompt's context as written, so a forged entry could add a "rule". | Only well-formed runs are kept (`userRuns`); notices and the title go in as one capped line (`contextLine`); `.assay/` is refused to Write. |
| PI-5 | Medium | `src/core/bashGuard.ts` | The Bash guard missed Python run through wrapper options with values (`nice -n 5`, `timeout -s KILL 5`, `env -u`, `env -S`, `sudo -u`), `xargs`, `find -exec`, `bash -lc`, `eval`, `watch`, grouping, `$(...)`, backticks, a variable naming python, `py`/`pypy`/`python3.13t`/`Python`, `-m runpy`/`code`/`timeit`, `uv run x.py`, `uvx python`, `jupyter execute`, `streamlit run`, `marimo run`. | Each form is refused, with a test per form. What a shell guard cannot see is accepted in security.md (L-1). |
| PI-6 | Low | `src/hooks/decide.ts`, `plugin/hooks/hooks.json` | A Write through a dangling symlink created its target in `trusted/`; `MultiEdit` was not in the hook's matcher. | Dangling links are followed to their target (40 hops at most); the matcher names `MultiEdit`. |
| UI-1 | High | `src/main/browse.ts`, `src/core/files.ts` | The Files tab handed any file that is neither text nor an image to its default handler: an executable with no extension runs in Terminal, a `.jar`, `.command` or `.webloc` runs or opens a bundle. Claude can write such a file, from a container too, without quarantine. | Only documents (pdf, Office, iWork, media) that are not executable open in their app (`defaultOpening`); anything else is shown in Finder. |
| UI-2 | Medium | `src/renderer/index.html` | The policy allowed inline script in the built app, so a sanitiser bypass in Mermaid's SVG would run script with the whole preload API. | `src/core/csp.ts` writes the policy at build: no `'unsafe-inline'` script outside the dev server, and `object-src`, `frame-src`, `base-uri`, `form-action` `'none'`. |
| UI-4 | Low | `src/renderer/index.html` | `connect-src` allowed `ws:` to any host. | Only the dev server's policy has `ws:`. |
| UI-5 | Medium | `src/core/settings.ts` | The renderer could set the root to `/` or the home folder, which becomes Claude's working folder and what a launcher mounts. | `normalizeRoot` refuses the home folder and every folder above it. |
| UI-6 | Low | `src/main/notes.ts` | A note file that is a symlink was shown, and saving it copied the target's text into `notes/`. | A linked note is neither read nor saved. |
| UI-7 | Low | `src/main/windowPages.ts` | `ELECTRON_RENDERER_URL` was honoured by the packaged app, loading any page with the preload API. | Only an unpackaged build reads it. |
| UP-1 | Medium | `src/main/backend.ts`, `src/hooks/decide.ts` | The installed backend under Application Support was trusted by its stamp file: an edited hook or server stayed in place for that version. | The copy is hashed again at each launch and copied again when it differs; the Write guard refuses `ASSAY_BACKEND` and `ASSAY_VENV`. |
| UP-2 | Medium | `.github/workflows/ci.yml` | The signing and notarization secrets were repository secrets, readable by a workflow edited on any pushed branch. | The release job uses the environment `release`, limited to `main` (a user step: ci-release.md, Secrets). `scripts/workflow.test.ts` checks that no other job names a secret. |
| UP-3 | Low | `.github/workflows/ci.yml` | The release checkout left a `contents: write` token in `.git/config` while dependency code ran. | `persist-credentials: false`; the one fetch that needs the token passes it. |
| UP-4 | Low | `.github/workflows/ci.yml`, `package.json` | Nothing checked that the built app's fuses were flipped; three fuses were left to Electron's default. | All eight are set; `scripts/fuse-check.ts` reads the built app's and fails on any difference. |
| UP-5 | Low | `src/main/update.ts` | electron-updater's differential download keeps the token's Authorization header across the asset's redirect. | Differential downloads, downgrades and prereleases are off (`UPDATER_OPTIONS`). |
| UP-7 | Info | `scripts/next-version.ts` | A tag like `v1.2.3-rc` gave version `1.2.NaN`. | A tag that is not `vMAJOR.MINOR.PATCH` stops the release. |
| DEP-1 | High | `package.json` | Electron 37 is out of support, with high advisories (context isolation bypass, sandbox escapes); `npm audit --audit-level=high` failed. | Electron 45.3; the token uses safeStorage's async API, which reads tokens saved by the old one. CI runs `npm audit --audit-level=high`. |
| DEP-2 | Low | `package-lock.json` | extract-zip's symlink traversal, used only by Electron 37's install. | Gone with DEP-1. |
| DEP-3 | Medium | `.github/workflows/ci.yml` | `npm ci` ran every dependency's install script on the release runner (`allowScripts` in package.json is not read by npm 10). | The release job runs `npm ci --ignore-scripts`, then the repo's own postinstall. |
| DEP-4 | Medium | `python/pyproject.toml` | On Python 3.10 the lock could only hold Pillow 12.3 and Tornado 6.5 with known vulnerabilities, and nothing pins the interpreter. | `requires-python >= 3.11`; CI runs `pip-audit --require-hashes` on every locked group on 3.11. |
| DEP-5 | Medium | `python/pyproject.toml` | The build backend (setuptools) is outside uv.lock and was fetched at its newest on every user's venv build. | Pinned as the backend and as a build constraint. Its hash is not checked (L-6). |
| DEP-6 | Low | `src/main/backend.ts` | The app's venv held the dev group (ruff, pytest-cov, pytest-xdist). | `--no-dev`. |
| DEP-7 | Low | `.github/workflows/ci.yml` | uv and pip-audit unpinned in CI. | Both pinned; `scripts/workflow.test.ts` checks. |

## Accepted

Listed with their reasons in `docs/process/security.md`: L-1 (what a shell guard cannot see), L-2 (tool results not
framed as data, PI-7), L-3 (venv content not re-hashed), L-4 (the `allow-unsigned-executable-memory` entitlement,
UP-6), L-5 (token scope not checkable, UP-8), L-6 (setuptools hash), L-7 (the analysis folder first on the kernel's
path, DEP-8), L-8 (moderate advisories in build tools), L-9 (a symlinked `.assay/requests/`), L-10 (zero-width
characters and paths outside the root in the Write guard).

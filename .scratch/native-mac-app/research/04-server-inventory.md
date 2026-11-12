# Research: what the TypeScript server, hooks and shared core do, and what moves to Python

Ticket: [issues/04-server-inventory.md](../issues/04-server-inventory.md). Source: the repository at `/home/user/assay`
as checked out on 2026-11-12. Every path below is relative to the repository root; line numbers are from that checkout.

## Scope and size

- In scope: `src/server` (21 non-test files), `src/hooks` (7 non-test files), `src/shared` (`ipc.ts`,
  `trustedCommit.ts`), the 13 core modules imported by both the server/hooks and the app (`analyses calculations
  citationLabels claudeState lineage nameOrder requests rootNotes runs steps threads trust venv`), and the 6 core
  modules only the server/hooks import (`bashGuard engines pythonRuns rules slugText text`). `src/core/errors.ts`
  (`StaleEdit`, 7 lines) comes along transitively through `threads.ts` and `rootNotes.ts`.
- Out of scope, as the ticket says: the 44 app-only core modules.
- Size: about 2,940 lines of non-test TypeScript in server, hooks and shared, and about 2,920 in the 19 core modules
  (`wc -l`). Not every core line moves: much of the 13 shared modules is app-side (Mermaid text, CSV parsing for
  the Data tab, Trust-tab wording, analysis creation).

## How the pieces fit

- **Launch.** The app runs `claude --mcp-config "$ASSAY_MCP_CONFIG" --plugin-dir "$ASSAY_BACKEND/plugin"` with
  `ASSAY_APP`, `ASSAY_ROOT`, `ASSAY_ANALYSIS`, `ASSAY_BACKEND`, `ASSAY_MCP_CONFIG`, `ASSAY_VENV`, `ASSAY_THEME`
  (`docs/process/launch-contract.md:12-27`). The MCP config is exactly
  `{"command":"node","args":["<ASSAY_BACKEND>/plugin/../out/server/index.mjs"]}`, and a launcher "may allowlist the
  server by this exact command" (`launch-contract.md:25,43-44`). The hooks are also `node …/out/hooks/*.mjs`
  (`plugin/hooks/hooks.json`). Both are **Node-specific parts of the launcher contract**, and Python would change them.
- **Server life.** One server per Claude session over stdio (`src/server/index.ts`, `main.ts:1-2`). Without
  absolute `ASSAY_ANALYSIS`, `ASSAY_ROOT` and `ASSAY_VENV` every tool answers `NOT_ASSAY` (`main.ts:27-39,58`;
  `src/core/rules.ts:15`). On start it creates the analysis's missing files, connects MCP, then starts the kernel and
  the request poller; closing stdin or SIGTERM/SIGINT/SIGHUP stops the poller and kills the kernel
  (`serve.ts:19-37`).
- **The kernel** is a child process, `python analysis_kernel.py serve --analysis … --connection <tmp>/assay-kernel-*.json`
  (`kernel.ts:156-165`). Each Python run is a short `analysis_kernel.py run … --code-file … --timeout 590 --serve-pid <pid>`
  client (`pythonRun.ts:66-71`). The kernel itself, `q(N)`, tables and plots are **already Python**
  (`python/analysis_kernel*.py`).
- **Heavy logic is already Python.** The server shells out to `python -m analysis_trust …` and
  `python -m analysis_sql …` in Assay's venv for SQL rules, include expansion, retype, lineage, steps plans, the
  dictionary, the trusted list, trusted runs, definition rendering and the Trust checks (`assay.ts:317-331`,
  `sqlRun.ts:131-158`, `stepsRun.ts:57-98`, `trustedRun.ts:31,47`, `trustStream.ts:23`). What TypeScript holds is
  orchestration: run numbering, files, queues, the request poller, process supervision, reply text and the hooks.

## The file protocol, by who writes what

All paths are relative to the analysis folder unless they start with `<root>` (ASSAY_ROOT) or `<venv>`.

| File | Written by | Read by | Source |
|---|---|---|---|
| `.assay/requests/<id>.json` (temp `.<id>.json.tmp`, renamed) | app (main) | server, polled every 500 ms, deleted before it runs | `src/main/requestFiles.ts:59-75`; `server/requests.ts:19,58-73` |
| `.assay/replies/<id>.json` `{id, number \| ok \| error \| proposals}` | server (atomic) | app, deleted once read | `server/requests.ts:49-51`; `core/requests.ts:74-92` |
| `.assay/runs.json` `{running, failed, kernel?}` | server (atomic) | app | `server/assay.ts:34,225-235`; `core/runs.ts:199-251` |
| `.assay/user-runs.json` (JSON list) | server appends | prompt hook takes (rename, read, delete) | `assay.ts:36,243-259`; `hooks/decide.ts:74-93` |
| `.assay/step-notices.json` (JSON list of lines) | server appends | prompt hook takes | `assay.ts:38`; `stepsRun.ts:164`; `decide.ts:96` |
| `.assay/session.json` `{python}` | server, at each kernel start | prompt hook | `kernel.ts:12,102`; `decide.ts:99-106` |
| `.assay/trust/<name>.json` | server (atomic, ordered) | app's Trust tab | `server/trust.ts:19,103-106`; `core/calculations.ts:262-277`; `core/trust.ts:46` |
| `.assay/claude.json` `{state, at}` | state hook | app's analysis strip | `hooks/recordState.ts`; `core/claudeState.ts:8` |
| `.assay/.gitignore` `*` | server and app | git | `assay.ts:187`; `requestFiles.ts:67` |
| `queries/NNN_<slug>.sql\|.py` | server (claimed under a queue) | app, kernel, citation labels | `assay.ts:283-293` |
| `queries/NNN_<slug>.csv` | server (SQL result; empty for no result set) | app, `q(N)` | `assay.ts:268` |
| `queries/NNN_<slug>.json`, `.tK.csv`, `.pK.png\|svg` | kernel runner (Python) | server reply, app | `python/analysis_kernel_run.py:1-4,108-181` |
| `queries/NNN.expanded.sql` (first line `-- blocks: …`) | server | app Code tab, Steps | `sqlRun.ts:56,119-121` |
| `queries/NNN.notices.json` `{rules, retype}` | server (Claude's runs only) | app Code tab | `sqlRun.ts:53,174-176` |
| `queries/NNN.lineage.json`, `NNN.steps.json`, `NNN.k_<name>.sql\|.csv\|.counts.sql` | server | app Steps tab, `q(N, step=k)` | `stepsRun.ts:48-49,139-147`; `python/analysis_kernel_preload.py:36-48` |
| `threads.md` | server tools and app edits | both | `assay.ts:22,215-222`; `src/main/files.ts:19` |
| `analysis.yaml` (`notes:` block, title, target) | server (note tools) and app | both, Python `analysis_db` | `server/notes.ts:257-261`; `core/rootNotes.ts:261-329` |
| `lib/__init__.py`, `queries/`, `lib/`, `tests/` | server creates if missing | — | `assay.ts:177-188` |
| `<root>/notes/<ID>-<slug>.md` | server note tools and app | both | `server/notes.ts`; `src/main/notes.ts` |
| `<root>/trusted/`, `<root>/dictionaries/` + git commit | server, only on a Trust-tab approval | Python helpers | `server/trustPromote.ts:51-64` |
| `<venv>.status.json` `{state: building\|ready\|failed}` | app (`backend.ts`) | server, Doctor | `core/venv.ts:7`; `src/main/backend.ts:84-89` |

Request kinds: `sql`, `python`, `interrupt`, `restart`, `replay`, `lineage`, `steps`, `trust-list`, `trust-check`,
`trust-answer` (`core/requests.ts:185-243`). Interrupt, restart, lineage and the three trust kinds are **urgent**:
taken at once even during a run; `sql`, `python`, `replay` and `steps` queue oldest first, one at a time
(`core/requests.ts:196`; `server/requests.ts:76-89`). Request ids are `<13-digit ms>-<6 [a-z0-9]>` so names sort by
time (`core/requests.ts:8-12`), sorted by UTF-16 code unit (`core/nameOrder.ts:5`).

## Per-module inventory

Columns: **Protocol** = files read (R) or written (W). **Python overlap** = whether `python/` already holds the same or
similar logic. **Swift needs** = what the Swift app must read or write itself, given that Python owns the protocol.

### src/server

| Module | Purpose | Protocol | Python overlap | Swift needs |
|---|---|---|---|---|
| `index.ts`, `main.ts`, `serve.ts` | Entry, config from env, MCP `ListTools`/`CallTool`, life cycle (`main.ts:27-76`, `serve.ts:19-37`) | env only | None: the Python MCP SDK is not in `pyproject.toml` | Nothing; Swift sets the env and `--mcp-config` |
| `tools.ts` | The 11 tool specs and dispatch; every tool refuses when `analysis.yaml` is missing (`tools.ts:245`); after a run, appends a once-per-session "search notes" hint (`tools.ts:178-184`) | via callees | None | Nothing |
| `assay.ts` | Session state: atomic writes, run-number claiming under a serial queue, `runs.json`, list appends, venv readiness, `helper()` that runs `python -m <module>` and parses JSON, dictionary text once per table per session, trusted list cached 20 s (`assay.ts:97-352`) | W `runs.json`, `user-runs.json`, `queries/NNN_*`, `.gitignore`; R `<venv>.status.json` | Partial: the helpers it calls are Python; numbering, queues and replies are not | R `runs.json` |
| `kernel.ts` | Starts, supervises, interrupts (`kill -USR1`), restarts the kernel; picks the nearest project `.venv/bin/python` if it imports ipykernel, else Assay's venv (`kernel.ts:80-89,139-147`); 120 s ready timeout, 3 tries; exit 2 = missing | W `session.json`, `runs.json` kernel state | The serve/run side is Python (`analysis_kernel_serve.py`) | R kernel state in `runs.json` |
| `proc.ts` | Child processes: run with timeout (SIGKILL, exit 124) and 4 MiB stdout cap; spawn with line reading (`proc.ts:23-101`) | — | `subprocess` covers it | — |
| `requests.ts` | The poller and the per-kind handlers; user SQL is **not** linted, only Claude's (`requests.ts:119-130` vs `sqlRun.ts:160`); user runs carry `-- author: user` / `# author: user` and `from`; replay restarts the kernel and re-runs Python runs marked `# replay: NNN`, stopping at the first that fails (`requests.ts:145-168`) | R/delete requests; W replies, `user-runs.json` | None | W requests, R replies |
| `sqlRun.ts` | SQL runs: expand includes → lint → retype → claim → run on `databricks experimental aitools tools query … --output json --file F 'SELECT 1'` or `rds-psql -X --csv -v ON_ERROR_STOP=1 -f F` (`sqlRun.ts:62-76`); writes header lines (`-- built from:`, `-- postgres`) | W `.sql`, `.csv`, `.expanded.sql`, `.notices.json` | Lint/expand/retype are Python (`analysis_sql`, `analysis_lint`, `analysis_include`, `analysis_retype`); the CLI call is not | R these files (Code/Data tabs) |
| `pythonRun.ts` | One Python run in the kernel queue; exit 3 = kernel unreachable → kernel dead (`pythonRun.ts:11,76-81`) | W `.py`; runner writes the rest | Runner is Python | R `.json`, tables, plots |
| `trustedRun.ts` | `trusted` tool: refuses dirty calculations, checks args, saves `-- trusted/-- args/-- commit` header, runs `analysis_trust run` | W `.sql`, `.csv` | `analysis_calc.convert` already checks args (`analysis_calc.py:227-250`); `analysis_library` lists commit/dirty | — |
| `stepsRun.ts` | Lineage and steps: `analysis_sql lineage`/`steps` plan, then each step's preview and counts on the engine; failed checks appended as notices | W `lineage.json`, `steps.json`, step files, `step-notices.json` | Plans are Python (`analysis_lineage`, `analysis_steps`); execution and checks (`core/steps.ts:191`) are TS | R `lineage.json`, `steps.json`, step CSVs |
| `notes.ts` | `note`, `revise_note`, `link_notes`, `note_labels` | R/W `<root>/notes/`, `analysis.yaml` `notes:` | None | R/W notes (the user edits them too) |
| `trust.ts`, `trustReview.ts`, `trustStream.ts`, `trustProposals.ts`, `trustPromote.ts` | One review at a time: list proposals in `lib/trusted/` and `lib/dictionaries/`; stream `analysis_trust check … --stream` (10 min cap); on `trust`, copy the checked text into `<root>/trusted\|dictionaries`, `git add`, `git diff --cached --quiet`, `git commit` those paths only, then remove unchanged drafts (`trustPromote.ts:23-81`) | W `.assay/trust/<name>.json`, `<root>/trusted\|dictionaries`, git | Checks are Python (`analysis_review`, `analysis_trust`); state machine and promotion are TS | R trust file; W `trust-*` requests |
| `testing.ts` | Test fakes | — | — | — |

### src/hooks

| Module | Purpose | Protocol | Python overlap | Swift needs |
|---|---|---|---|---|
| `io.ts` | Read hook JSON from stdin; print `deny` / `additionalContext` JSON; print nothing to let the call through (`io.ts:1-32`) | — | None | — |
| `bash.ts` + `decide.ts:36-39` | PreToolUse Bash: deny Python run through Bash | — | None | — |
| `write.ts` + `decide.ts:49-71` | PreToolUse Write/Edit/NotebookEdit: deny writes into another analysis, `<root>/notes`, `<root>/trusted`, `<root>/dictionaries` (symlinks resolved, case-insensitive) | R `analysis.yaml` (title for the message) | None | — |
| `prompt.ts` + `decide.ts:124-135` | UserPromptSubmit: the rules, the user's runs and failed step checks since the last prompt, the trusted list | takes `user-runs.json`, `step-notices.json`; R `session.json`, `analysis.yaml`; runs `analysis_trust list` | `list` is Python | — |
| `state.ts`, `recordState.ts` | On UserPromptSubmit, PostToolUse, PreToolUse(AskUserQuestion), Notification, Stop: write Claude's state | W `.assay/claude.json` | None | R `claude.json` |

### src/shared

| Module | Purpose | Protocol | Python overlap | Swift needs |
|---|---|---|---|---|
| `ipc.ts` | Types and channel names between Electron main, preload and renderer only (`ipc.ts:1-6`); the server never imports it | — | n/a | Nothing: Electron-only; the Swift app's own model replaces it |
| `trustedCommit.ts` | `currentCommit(root, name)`: 12-hex commit that last changed `trusted/<name>.sql\|py`, cached 20 s; used by the server and main so both call a citation stale by one rule (`trustedCommit.ts:1-43`) | git in `<root>/trusted` | `analysis_library.file_state` runs the same `git log -1 --format=%H` (`analysis_library.py:32-36`) | Same rule, if Swift labels citations itself |

### The 13 core modules shared by server/hooks and app

| Module | Purpose | Server/hooks use | Python overlap | Swift needs |
|---|---|---|---|---|
| `analyses` | `analysis.yaml` reading (first `key:` line wins, quoted scalars, ` #` comments), slugs, listing, create, rename (`analyses.ts:64-178`) | `ANALYSIS_FILE`, `folderName`, `openAnalysis` | `analysis_db.read_target` mirrors `readTarget` for profile/warehouse (`analysis_db.py:44-71`, says so in its docstring) | Yes: picker, create, rename are app-side |
| `calculations` | Trust constants and paths, dictionary text, `isGuarded`/`otherAnalysis`, `checkArgs`, trusted run header, `splitCheckEvents`, `TrustFile` type | server (trusted, trust, dictionary), write hook | Arg types in `analysis_calc.convert`; list/commit/dirty in `analysis_library` | Only the `TrustFile` shape and constants |
| `citationLabels` | Label of `[<slug> q N]`: trusted / queried / computed / unverified / stale / missing, from run files and `currentCommit` (`citationLabels.ts:25-50`) | `note_labels`, note warnings | None | Yes: Notes reader shows labels |
| `claudeState` | Hook event → `working\|waiting\|idle`; file shape (`claudeState.ts:16-48`) | state hook | None | R `claude.json` |
| `lineage` | Parse `lineage.json`; draw Mermaid; Steps view state (`lineage.ts:53,103`) | type only (`stepsRun.ts:7`) | Producer is `analysis_lineage` | Yes: Steps tab (out of the core subset) |
| `nameOrder` | `byCodeUnit` sort, finished `.json` names | request order, note listing | Python's default `str` sort is by code point, which differs from UTF-16 order only above U+FFFF | Yes: ordering |
| `requests` | Request writer (app), reply parser (app), request-file parser and `isUrgent` (server), `canRerun`, selection SQL | `parseRequestFile`, `isUrgent`, types | None | W requests, R replies |
| `rootNotes` | Note IDs (`YYYYMMDDTHHMMSS`, a second later while taken), file names, links `[[ID]]`, citations, qualifying `[q N]`, exact-once replace, `notes:` block of `analysis.yaml`, `writeRootNote` (`rootNotes.ts:33-378`) | note tools, write hook | None | Yes: Notes tab parses and edits notes |
| `runs` | `queries/` names regex (`runs.ts:34`), result `.json`, CSV, `runs.json`, run headers, labels, `nextRunNumber` = max + 1, never reused (`runs.ts:337`) | numbering, headers, `codeBody` | `analysis_kernel_preload.q` globs the same names (`analysis_kernel_preload.py:36-83`) | Yes: History/Code/Data tabs |
| `steps` | Parse `steps.json`, step file names, grain/join checks on counts, notice line (`steps.ts:98-237`) | checks and notices | `stepSlug` rule duplicated in the preload (`analysis_kernel_preload.py:48`) | Yes: Steps tab |
| `threads` | `threads.md` parse/format (`## Open` numbered, `## Closed` `- x → outcome`); tool ops by number, exact text or unique substring; app edits with stale checks (`threads.ts:10-156`) | park/close/focus/order | None | Yes: app edits threads.md too |
| `trust` | Parse `.assay/trust/<name>.json`, states, Trust-tab wording, the failure line typed into Claude (`trust.ts:4,46,122`) | `TrustState` type only | None | Yes: Trust tab |
| `venv` | `<venv>.status.json` parse; hints | server readiness | None | W status (app builds the venv) |

### The 6 server/hooks-only core modules

| Module | Purpose | Python overlap | Notes for the port |
|---|---|---|---|
| `bashGuard` | Hand-written shell splitter: `;`, `&&`, `\|\|`, `\|`, `&`, newlines, quotes, heredoc bodies dropped, `env`/`time`/`sudo`/`timeout` prefixes, `bash -c` up to 3 deep, `uv run python`; Python counts as running code with a script, `-c`, `-`, a redirect or a pipe; `-m …`, `--version` do not (`bashGuard.ts:5,195`) | None (`shlex` is not a drop-in: the reader keeps segment and pipe state) | Port line for line with its tests (`bashGuard.test.ts`) |
| `engines` | Target from `analysis.yaml` (defaults profile `Cint mkt`, a fixed warehouse), Databricks CLI JSON and psql CSV parsing (`engines.ts:8-86`) | `analysis_db.read_target`; `csv` module | Easy |
| `pythonRuns` | `queryLabel` (3-digit), `runSlug` (kebab, 48), CSV writing, table text, kernel events, runner line parsing, Python reply text, headers, `venvCandidates` | Kernel side is Python | Reply text must match byte for byte if tests or skills rely on it |
| `rules` | The whole UserPromptSubmit text: open analysis, reply rules, run notice, trust rules, trusted list (`rules.ts:21-99`); `toolName` = `mcp__assay__<tool>` | None | Plain strings; port verbatim |
| `slugText` | `kebabCase`, trailing-slash strip, without regex backtracking | None | Trivial |
| `text` | `oneLine`, `shellQuote` | `shlex.quote` is close but quotes differently | Trivial |

## Claude's MCP tools (`src/server/tools.ts`)

Every tool first refuses when the analysis has no `analysis.yaml` (`tools.ts:245`), and answers `NOT_ASSAY`
outside an Assay session (`main.ts:58`). A thrown error becomes `The <name> tool failed: <message>` (`main.ts:44-46`).

| Tool | Inputs | Behaviour |
|---|---|---|
| `sql` | `sql`, `slug`, `engine?` (`databricks` default, `postgres`) | Expand `{{ … }}` includes (`analysis_sql expand`); if any WITH/JOIN, lint (`analysis_sql lint`), and a rule error rejects with no run number; retype warnings (Databricks only); claim the next number, save, run, write `.csv`; reply with up to 50 rows (cells cut at 80), dictionary text for tables first seen, warnings, and `Built from:` (`sqlRun.ts:160-182`, `assay.ts:88-95,262-280`). 10 min timeout; 4 MiB result cap |
| `python` | `code`, `slug` | One at a time in the kernel; restarts a dead kernel and says variables are gone; reply has status, time, stdout, last 30 traceback lines, each table (50 rows) and plot path (`pythonRun.ts`, `core/pythonRuns.ts:148`) |
| `trusted` | `name`, `args?` (object) | Fresh trusted list; unknown name lists the others; dirty refuses and points to the Trust tab; args type-checked; saved with `-- trusted:`, `-- args:`, `-- commit:`; run by `analysis_trust run`; definitions rendered by `analysis_trust render` (`trustedRun.ts`) |
| `park` | `thread` | Append one line to Open; reply with open count |
| `close` | `thread` (number or text), `outcome?` | Move to Closed with ` → outcome`; reply with the next open thread |
| `focus` | `thread` | Move to the top |
| `order` | `threads[]` | Listed threads to the top in order, rest keep order; refuses duplicates |
| `note` | `title`, `text` | New `<root>/notes/<ID>-<slug>.md`, never overwriting; bare `[q N]` qualified with the analysis slug; ID added to `notes.written`; warns about unknown runs and unresolved links (`notes.ts:51-82`) |
| `revise_note` | `id`, and `old`+`new`, or `title`, or `delete` | Exact-once body replacement (refused when missing or repeated), retitle (file name stays), or delete only a note this analysis wrote (`notes.ts:84-125`) |
| `link_notes` | `ids[]` | Refuses any unknown ID; adds the others to `notes.found`, skipping this analysis's own (`notes.ts:130-144`) |
| `note_labels` | `id?`, `weak?` | Per note `<ID> <title>`, then `[<slug> q N] <label>` per distinct citation, weak first and weak notes first; says when stale could not be checked (`notes.ts:201-217`) |

Concurrency rules the port must keep: one serial queue for threads, `analysis.yaml` and run-number claims; a
separate queue for kernel runs; a queue for list appends; the run number is claimed and `runs.json` written
**before** the run's file, so the app never sees a run it does not know is running (`assay.ts:109-113,283-293`).

## Hook behaviour the Python hooks must match

From `plugin/hooks/hooks.json` and `src/hooks/decide.ts`:

1. **UserPromptSubmit → prompt** (timeout 40 s). Only with `ASSAY_ANALYSIS` and `ASSAY_ROOT`. Takes
   `user-runs.json` and `step-notices.json` by rename-then-read-then-delete, reads `session.json`, runs
   `<venv>/bin/python -m analysis_trust list <root>` (30 s), and prints `additionalContext` =
   `promptContext(...)` (`decide.ts:124-135`, `rules.ts:97-99`). Names the kernel's python, else the venv's if it exists.
2. **UserPromptSubmit, PostToolUse(*), PreToolUse(AskUserQuestion), Notification, Stop → state**. Writes
   `.assay/claude.json` atomically: `working` on prompt/post-tool, `waiting` on AskUserQuestion and on
   `permission_prompt`/`elicitation_dialog` notifications, `idle` on Stop; never fails the turn (`claudeState.ts:16-36`,
   `recordState.ts`).
3. **PreToolUse(Bash) → bash**. In an Assay session, deny with `BASH_PYTHON_DENY` when `bashRunsPython(command)`
   (`decide.ts:36-39`).
4. **PreToolUse(Write|Edit|NotebookEdit) → write**. Resolve `file_path`/`notebook_path` against `cwd`, symlinks
   followed as far as the path exists; deny another analysis, `<root>/notes`, then `<root>/trusted` and
   `<root>/dictionaries`, each with its own message (`decide.ts:19-71`).

Hook output: nothing and exit 0 lets the call through; otherwise one JSON line (`io.ts:25-32`). A hook that has to
start Python on every tool call (the state hook runs on **every** PostToolUse) pays interpreter start-up each time;
Node pays a similar cost today. This is worth measuring before the decision, not assumed.

## What the Swift app would read and write

Given "Python owns the file protocol; the Swift app reads it" (map), the Swift app still has to:

- **Write**: `.assay/requests/<id>.json` (all ten kinds), `<venv>.status.json` while it builds the venv, and the
  user's own edits to `threads.md`, `analysis.yaml` (title, create) and root notes (the Electron app edits all three:
  `src/main/requestFiles.ts:1-2,40-57`, `src/main/notes.ts:62`).
- **Read**: replies, `runs.json`, `claude.json`, `trust/<name>.json`, `queries/` (names, code, headers, CSV, result
  JSON, plots, `expanded.sql`, `notices.json`, `lineage.json`, `steps.json`, step CSVs), `threads.md`, `analysis.yaml`,
  `<root>/notes/`.
- **Re-derive**: run labels and citation labels (including the `git log` commit rule), note parsing (links,
  citations, blocks), thread parsing and stale-edit checks. These sit in the 13 shared modules today and would have to
  exist in Swift too, or be served by Python on request.

## Implications for the decision

1. **Most of the domain logic is already Python; the port is orchestration.** SQL rules, includes, retype, lineage,
   step plans, the dictionary, trusted calculations and the Trust checks all run as `python -m analysis_*` today.
   Moving the server to Python turns those subprocesses into in-process calls, which is simpler and faster
   (each helper call currently pays a fresh interpreter, up to four per Claude `sql` call).
2. **What must be written fresh in Python:** the MCP layer (a new dependency, `mcp`, not in `pyproject.toml`), the
   request poller, run claiming and queues, kernel supervision, Databricks CLI and psql calls, the trust state machine
   and git promotion, the four note tools, the thread tools, the Bash guard and the prompt rules text. Roughly
   3,000 lines of TypeScript plus its tests.
3. **The launch contract changes.** `ASSAY_MCP_CONFIG`'s exact `node …/index.mjs` command, which launchers may
   allowlist, and "provide node 22 or later" (`launch-contract.md:43-51`) become a Python command in the venv. The
   Podman wrapper must be updated in step, and the hooks in `hooks.json` change from `node` to the venv's python.
   There is a bootstrap question: hooks and the server need the venv, which the app builds in the background
   (`launch-contract.md:31-35`); today the Node server answers "still building" instead of failing.
4. **Duplication moves rather than disappears.** Thirteen modules are shared because the app and the server parse the
   same files. With a Swift app, rules such as run-file names, run headers, `threads.md`, root notes, `notes:` lists,
   citation labels and step file names exist twice (Python and Swift), as `read_target` and `stepSlug` already exist
   twice today. A shared fixture set (sample folders and expected parses) used by both test suites would keep them
   in step. The other option is for Python to serve derived views (labels, parsed notes) to Swift on request, which
   narrows Swift to rendering at the cost of more request kinds.
5. **Parity bar subset.** For Code, Data, History, Notes and Trust, Swift needs `runs`, `requests`, `rootNotes`,
   `citationLabels`, `threads` (for edits), `trust`, `analyses`, `claudeState` and `venv`. `lineage` and `steps` are
   only needed once the Steps tab follows, although the Python server must still write their files for `q(N, step=k)`.
6. **Behaviour to keep exactly:** request urgency and order, claim-before-write, user SQL not linted, the 50-row and
   80-character reply limits, 10-minute timeouts and 4 MiB cap, kernel exit codes (2 missing, 3 unreachable), atomic
   writes via temp-and-rename, take-by-rename for the hook lists, case-insensitive guarded paths, and the exact
   reply and rule strings that the skills and tests quote.

## Open points not settled here

- Hook start-up cost in Python against Node, on every PostToolUse: not measured.
- Whether the Python MCP SDK's stdio server handles the shutdown signals as `serve.ts` does: to be checked in its docs.
- `rules.ts:8-11`'s comment describes the plugin naming (`mcp__plugin_…`) while the code returns `mcp__assay__…`; the
  code matches the launch contract, the comment is stale.

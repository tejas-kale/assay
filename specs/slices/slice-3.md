# Slice 3 spec: shared kernel, Python runs and Plots

Implements "Build slices" item 3 of `HANDOFF.md`. Read `HANDOFF.md` first (it wins on product intent, and its
"Decided while building" section overrides older parts of it), then `specs/slices/slice-2b.md`: this slice extends its request
and reply files to Python. `specs/slices/slice-1.md` still holds for the layout of the code, IPC and tests.

## Build environment

- App (`~/Code/assay`): `npm test` and `npm run typecheck` must pass. New dependency allowed: `@codemirror/lang-python`.
- Mod (`~/Code/config/claude/analysis`): `cd ~/Code/config/claude/analysis && /opt/homebrew/bin/claude plugin test .`
  (plain `claude` is the Podman wrapper). The mod API types are in `types/` and the generated
  `.claude-plugin/types/` when present; an older full copy is `~/Code/config/claude/investigate/.claude-plugin/types/claude-code/index.d.ts`.
  Gotchas: `~/Code/config/LEARNINGS.md`.
- Runner (`~/Code/config/claude/analysis/notes-src/analysis_kernel.py`): Python ≥ 3.12, tested with pytest in a scratch
  venv that has `ipykernel`, `pandas`, `polars`, `matplotlib` (build it with `uv` under the session's scratch folder, as
  `notes-src/tests/test_venv.sh` does). Never create or change a venv in `~/Code/notes-src`.
- In `~/Code/config` commit only this slice's files, staged by explicit path. `nvim/` holds the user's uncommitted
  changes: never stage, stash, reset or check them out. If a commit fails on `index.lock`, wait a second and retry.

## What the user gets

1. Claude runs Python with a `python` tool (`mcp__analysis__python`) in one kernel per session. Each run is saved as a
   numbered run beside the SQL runs, and shows in the app at once: Code, Data (tables, stdout, error) and Plots.
2. `df = q(12)` in the kernel loads run 12's saved result with no warehouse call. The run records which runs it read.
3. In Code, a Python run can be re-run (Cmd+Enter) or edited (`i`, then Cmd+Enter) as a new run in the same kernel.
4. Cmd+. interrupts the running Python run. The palette has "Restart kernel" and "Replay".
5. Replay re-runs chosen Python runs, in order, in a new kernel.
6. A note citing a successful Python run is labelled `computed`.
7. On the user's next prompt, Claude is told which runs the user made since its last turn.
8. Claude's Bash calls that run Python code are refused, pointing to the `python` tool.
9. The mod and the app stop knowing about the Molten notebook (`notebook.md`); it stays as the user's private tool.

## The contract

Files stay the contract. The app keeps no database. Python and SQL share one number sequence: `[q 012]` names one run.

### Run files

```
queries/NNN_<slug>.py        the exact text run in the kernel: header lines, then the code
queries/NNN_<slug>.json      the run's result (below); written by the runner
queries/NNN_<slug>.tK.csv    table K (1-based) the run displayed
queries/NNN_<slug>.pK.png    plot K (1-based); .pK.svg when the plot came as SVG only
```

A Python run has no `NNN_<slug>.csv`. Header lines at the top of the `.py` (Python comments, so the file runs as it is):

```
# author: user          the user's run (absent: Claude's)
# from: 012             the run it was edited or re-run from
# replay: 012           a replay of run 012 (with `# author: user`)
```

`.json`, written atomically (temp file `.<name>.tmp` in `queries/`, then rename) every 0.5 s while running and once at
the end:

```json
{ "status": "running" | "ok" | "error" | "interrupted",
  "kernel": "<kernel id>", "startedAt": 1730000000000, "endedAt": 1730000002300,
  "stdout": "<text>", "stdoutTruncated": true,
  "error": { "name": "KeyError", "message": "'x'", "traceback": "<plain text, no ANSI>" },
  "tables": [{ "file": "014_x.t1.csv", "columns": ["a", "b"], "rowCount": 12000, "truncated": false }],
  "plots": [{ "file": "014_x.p1.png" }],
  "reads": [12] }
```

`stdoutTruncated`, `error` and `endedAt` are optional. `stdout` includes the plain-text form of non-table, non-plot
results (an expression's `Out` value). Limits per run: 20 tables, 20 plots, 100 000 rows per table CSV (`truncated`
true past that, `rowCount` the full count), 1 MB of stdout (the first 1 MB kept, `stdoutTruncated` true).

### Labels

`computed` is new: a Python run whose `.json` has `status: "ok"`. Any other Python run is `unverified`. A note citing
a Python run takes its run's label (`computed` or `unverified`). SQL labels keep their meaning. The app's `runLabel`
adds `computed`; `running` still wins while `.assay/runs.json` names the run.

### `.assay/runs.json` (mod writes) gains the kernel

```json
{ "running": { "number": 14, "startedAt": 1730000000000 } | null,
  "failed": { "13": "message" },
  "kernel": { "state": "starting" | "idle" | "busy" | "dead" | "missing", "message": "<why, for dead or missing>" } }
```

`kernel` is absent when no kernel was ever started. `missing` means no venv or no `ipykernel` in it; `message` says
what to do (`Add ipykernel to notes-src/pyproject.toml and run claude-pkg uv sync`).

### Requests and replies (extends slice 2b)

Same paths, id format, atomic write and deletion rules as slice 2b. New kinds:

```json
{ "id": "<id>", "kind": "python", "code": "<code, no header lines>", "from": 12, "slug": "<slug>" }
{ "id": "<id>", "kind": "interrupt" }
{ "id": "<id>", "kind": "restart" }
{ "id": "<id>", "kind": "replay", "runs": [12, 14, 15] }
```

Replies:

- `python`: `{ id, number }` once the run finished (any status), or `{ id, error }` when refused (empty code).
- `interrupt`, `restart`: `{ id, ok: true }` once done, or `{ id, error }`.
- `replay`: `{ id, ok: true }` after the last replayed run finished; `{ id, error: "Replay stopped at run 017 (replay of 014): <status>" }`
  at the first run that is not `ok`; `{ id, error }` when a listed number is not a Python run (nothing runs then).

`interrupt` and `restart` are taken at once, even while a run is in progress. `sql`, `python` and `replay` keep the
slice 2b order: one at a time, in name order.

## Runner (`notes-src/analysis_kernel.py`, config repo)

A single file with no imports outside the standard library, `jupyter_client` and `ipykernel` (which brings
`jupyter_client`). Master copy in `claude/analysis/notes-src/`, as for `analysis_db.py`; the user copies it into
`~/Code/notes-src` (it is run by path, so no `py-modules` change is needed). Add `ipykernel` to the reference
`notes-src/pyproject.toml` if missing. Two commands:

**`python analysis_kernel.py serve --analysis <dir> --connection <file>`**: long-lived, spawned by the mod.

- Starts an `ipykernel` with `jupyter_client.KernelManager`, cwd `<dir>`, connection file `<file>`.
- Runs the preload in the kernel (below), then prints one line `{"event": "ready", "kernel": "<id>", "pid": <serve pid>}`.
- `SIGUSR1` interrupts the kernel (`km.interrupt_kernel()`) and prints `{"event": "interrupted"}`.
- `SIGTERM`, `SIGHUP` or stdin closing: shuts the kernel down, prints `{"event": "stopped"}`, exits 0.
- The kernel dying by itself: prints `{"event": "dead", "message": "..."}` and exits 1.
- Missing `ipykernel`: prints `{"event": "missing", "message": "..."}` and exits 2.

**`python analysis_kernel.py run --connection <file> --analysis <dir> --code-file queries/NNN_x.py --timeout <s> --serve-pid <pid>`**:
one run, called with `$.process.run`.

- Executes the code file's text in the kernel through a `BlockingKernelClient`.
- Writes `queries/NNN_x.json` (`running` every 0.5 s, final at the end), `.tK.csv` and `.pK.png|svg` as in the contract.
- Tables: the preload registers an IPython formatter for a mimetype `application/vnd.assay.table+json` on pandas
  `DataFrame`/`Series` and polars `DataFrame`/`Series`, giving columns, CSV text (capped) and the full row count. Any
  displayed table (last expression, `display()`) becomes a table file.
- Plots: `image/png` (preferred) or `image/svg+xml` outputs. The preload enables matplotlib's inline backend, so figures
  appear at the end of the cell without `plt.show()`.
- `reads`: the preload's `q` records numbers; the client reads and clears them with `user_expressions` after the run.
- At `--timeout`, interrupts the kernel (`interrupt_request` on the control channel is not reliable: ask the kernel
  manager: `SIGUSR1` to `--serve-pid`), and finishes with `interrupted`.
- Prints one JSON line to stdout: `{ "status", "stdout": "<last 4000 chars>", "error"?, "tables": [{ "file", "columns",
  "rows": <first 50 rows as strings>, "rowCount", "truncated" }], "plots": [<file>], "reads": [..] }`. Exit 0 whenever
  the run was carried out, whatever its status; non-zero only when the kernel could not be reached.

**Preload** (run once per kernel): `os.chdir(<dir>)`, `<dir>` first on `sys.path` (so `from lib.x import ...` works),
the table formatter, `%matplotlib inline`, and:

- `q(n, k=1) -> pandas.DataFrame`: a SQL run's `queries/<n>_*.csv`, or table `k` of a Python run. Reads no warehouse.
  Raises `LookupError("Run 012 has no saved result")` when there is none. Records `n` in the reads list.

Tests (pytest, real kernel in the scratch venv): a print and an expression land in `stdout`; a DataFrame becomes
`t1.csv` with columns and row count; the row cap truncates; a matplotlib figure becomes `p1.png`; an exception gives
`error` with a plain traceback; state persists between two `run`s; `q(n)` reads a SQL csv and a Python table and is
recorded in `reads`; a `time.sleep` past `--timeout` ends `interrupted` and the kernel still answers the next run.

## Mod (config repo, `claude/analysis`)

Reuse `runQuery` (its number claim, `writeAppStatus`, `failures`, pane refresh), `deriveLabel` and the `sql` tool's shape.
Do not fork them: extend them where Python needs it.

- **Names:** `parseQueryName` and `nextQueryNumber` count `.py` and `.json` runs, and ignore `.tK.csv` and `.pK.*` for
  `hasCsv`. Tests in `model.test.ts`.
- **`computed`:** `LABELS` gains `computed`. `QueryFacts` gains what Python needs (language, `.json` status), and
  `deriveLabel` gives `computed` for an `ok` Python run, `unverified` for any other Python run. The pane colours it.
- **Kernel:** started when the session starts in, or adopts, an analysis (not before), with
  `$.process.spawn([python, <notesHome>/analysis_kernel.py, 'serve', ...])` and a connection file under the container's
  temp dir. The spawn loop reads the events and keeps `kernel.state` in `runs.json`. No venv, no runner file or
  `missing`: state `missing` with the message, and the `python` tool answers with it.
- **`python` tool:** `{ code: string, slug: string }`, described like `sql`. Saved through `runQuery` as `NNN_<slug>.py`
  (the runner extension of `runQuery` may let a runner choose the code file's extension and skip the `.csv`). Runs go
  through one queue, in arrival order; the run command gets `timeoutMs` 600 000 and `--timeout 590`. Claude's reply:
  `Run 014: ok (2.3 s).`, then stdout's tail, the error's traceback (last 30 lines), each table as
  `Table K (<file>): N rows. Columns: ...` with at most 50 rows through `formatTable`, and each plot as
  `Plot: queries/<file> (Read it to check the chart.)`.
- **Requests:** `parseRequest` takes the new kinds. Each tick takes `interrupt` and `restart` first and at once, even
  while another request runs (`interrupt` sends `SIGUSR1` to the serve pid; `restart` stops the serve loop and starts a
  new one). A `python` request is saved with `# author: user\n` and `# from: NNN\n` when `from` is set. `replay`:
  restart the kernel, then run each listed Python run's code (its `.py` minus header lines) as a new run with
  `# author: user\n# replay: NNN\n`, stopping at the first that is not `ok`.
- **Run notice:** on each of the user's own prompts in an analysis, if runs with `author: user` (SQL `-- author: user`,
  Python `# author: user`) were made since the last notice, add a line to the rules:
  `Since your last turn the user ran: 014 python (from 012), 015 sql. Their Python ran in your kernel, so its variables may have changed; read queries/<file> when it matters.`
  The first prompt of a session notices only runs made during the session.
- **Bash guard:** in an analysis, a `tool.call` handler on `Bash` denies commands that run Python code: `python`,
  `python3`, `python3.N`, `ipython`, any path ending in `/python` or `/python3`, or `uv run python`, when given a `.py`
  file, `-c`, `-` or a heredoc, or fed by a pipe. `python -m pytest`, `pytest`, `python -m pip`, `claude-pkg ...`,
  `uv sync`/`uv add`, and `python --version` pass. The deny says:
  `Run Python with mcp__analysis__python: it runs in the kernel the user sees, and every run is saved. pytest and package commands stay allowed.`
  Put the matcher in `model.ts` as a pure function with table tests.
- **Rules:** `analysisRules` replaces the notebook lines with the `python` tool's: run all Python with it; the kernel
  is shared with the user and keeps state; `q(N)` loads saved results instead of re-querying; keep output lean
  (summaries, `.head()`, counts, charts); plots with matplotlib (Altair charts are not captured in v1); reusable code in
  `lib/` with tests, as today.
- **Molten removal (last commit of the slice, user's decision 2026-11-02):** the mod stops knowing about `notebook.md`.
  Remove the `run_notebook` tool, the notebook rules, the Notebook tab and `/an notebook`, the `notebook.md` template in
  `setUp`, the `Stop` hook entry in `hooks/hooks.json` with `hooks/lean.mjs`, and `hooks/notebook.ts` with their tests
  where nothing else uses them. `skills/resume/SKILL.md` stops reading `notebook.md`; `migrate` stops adding it. Keep
  `notes-src/analysis_notebook.py` and its tests (the user's private Molten use), `analysis_db.py`, `lib/`, `tests/`,
  and every existing `notebook.md` file. Update `README.md` to match.

Mod tests: names and `computed`; the Bash matcher; the request kinds (a python request saves the header and replies
with the number; interrupt and restart are taken while a run is in progress; replay stops at the first failure;
unknown numbers refuse the replay); the run notice text; the python tool's reply format with a faked runner.
Fake `$.process.spawn`/`run` in `tests/fake.ts` as needed.

## App (`~/Code/assay`)

### Core (pure, tested first with `node:test`)

- **`core/runs.ts`:** `parseRuns` reads `.py`, `.json`, `.tK.csv`, `.pK.png|svg`. `Run` gains `result?` (the `.json`
  name), `tables: string[]` and `plots: string[]` (in K order), and `status?: 'running' | 'ok' | 'error' | 'interrupted'`
  (main fills it from the `.json`). `data` stays the SQL `.csv` only. `parseRunHeader` reads `# author:`, `# from:`,
  `# replay:` for Python (`RunHeader` gains `replay?: number`). `codeBody(text, language)` replaces `sqlBody` for both
  languages (keep `sqlBody` as its SQL case if callers need it). `runLabel` adds `computed`. `parseRunResult(text)`
  reads the `.json` safely (unknown fields ignored; undefined when unreadable).
  `parseRunStatus` reads `kernel`.
- **`core/facts.ts`:** a fact citing a Python run gets `computed` when that run's status is `ok`, else `unverified`.
  Pass what the derivation needs (for example a `labelOf(number)` function built from the runs) instead of bare names.
- **`core/requests.ts`:** `pythonRequest({ id, code, from?, slug? })`, `interruptRequest(id)`, `restartRequest(id)`,
  `replayRequest(id, runs)`. `Reply` gains `{ id, ok: true }`. `canRerun` allows Python runs; a trusted Python
  calculation (`-- python:` body) still refuses: "Run a trusted calculation with Claude's trusted tool".
- **`core/dataTabs.ts`:** `Seen` gains `plots` (file names); Plots is marked when the current run's plots change, like
  the others.
- **`core/keymap.ts`:** new `run.interrupt` "Interrupt run", Cmd+. (`code: 'Period'`). `kernel.restart` and
  `replay.open` lose `unavailable`. `PANE_KEYS` gains Data's `[ / ]` (table) and `s` (stdout), Plots' `j / k`, and
  Replay's keys.
- **`core/replay.ts`:** a reducer for the Replay view: the list of Python runs, oldest first, cursor `j`/`k`, `space`
  toggles, `a` all/none, `Enter` asks to confirm, `y` sends, `n`/`Escape` back. Returns the chosen numbers in run order.

### Main

- `loadState` fills `status` for Python runs from the `.json`. Cache a `.json` only once its status is final.
- `readRun(number)` returns, for a Python run, the code, the parsed `.json`, and table K on request
  (`readRun(number, { table: K })`, rows capped as for SQL). New IPC `readPlot(number, K) -> { ok, dataUrl } | { ok: false, message }`
  (PNG and SVG as data URLs; refuse names outside `queries/`).
- `runs.request` takes the new kinds (a `RunRequest` union: `sql`, `python`, `interrupt`, `restart`, `replay`).
- A running Python run's `.json` is rewritten every 0.5 s by rename; make sure the poll sees it (the `queries/`
  listing changes) and the state push carries it.

### Renderer

- **Run header:** the kernel state at the right (`kernel idle`, `busy`, `starting`, `dead`, `missing`); `replay of 012`
  beside `from 012`; `computed` chip (its own colour).
- **Data tab, Python run:** the table grid (existing) over table K, with `[` and `]` to switch and `table K of N` in
  the header; `s` toggles a text view of stdout and the error (traceback in a monospace block). A run with no tables
  opens on the text view. While the run is `running`, the text view updates on each state push.
- **Plots tab:** the current run's plots, one at a time, fit to the pane; `j`/`k` move between them, `plot K of N`.
  No plots: `Run 014 has no plots.`; a SQL run: `SQL runs have no plots.`
- **Code tab:** Python highlighting (`@codemirror/lang-python`) and the same edit flow as SQL; Cmd+Enter sends a
  `python` request with `from` and `slug` of the run; the toast says "Sent to Claude's session…" as for SQL.
- **Cmd+. (`run.interrupt`):** sends `interrupt` when a Python run is running, else toasts `Nothing is running.`
- **Restart kernel (palette):** asks `Restart the kernel? Its variables are lost. y / n` in a toast, then sends `restart`.
- **Replay (palette):** opens the Replay view in the data pane, focused, over the Python runs. Confirm text:
  `Replay N runs in a new kernel? y / n`. On send: back to the previous tab, follow latest.
- Replies: `ok` gives a short toast (`Kernel restarted.`, `Interrupted.`, `Replay finished.`); `error` a warning toast.
- Keyboard focus: after each of these actions focus stays in, or returns to, the data pane, so the next key works.

## Decisions recorded (from "Open for the build")

- **Mod to runner:** a long-lived `serve` process per session over `$.process.spawn`, whose stdout carries events, and a
  short `run` client per run over `$.process.run` against the kernel's connection file. `$.process.spawn` takes stdin
  only once (`input` is written, then closed), so the mod cannot send runs over the serve process's stdin.
- **Output streaming:** the `.json` is rewritten every 0.5 s while running, matching the files-only decision.
- **`q(N)` returns pandas.** Capture handles pandas and polars.
- **Limits:** 20 tables, 20 plots, 100 000 rows per table, 1 MB stdout per run. The Data tab loads rows as for SQL.
- **Interrupt:** Cmd+. in the app; Claude's `python` tool times out after 10 minutes, as `sql`, by interrupting the run.
- **Replay** runs get new numbers, marked `# replay: NNN`, in a new kernel, and stop at the first failure.
- **Kernel start:** when the session starts in, or adopts, an analysis; it ends with the session.
- **Runner location:** run by path from notes-src (`<notesHome>/analysis_kernel.py`), master copy in the config repo.

## Not in this slice

`notes/` Zettelkasten files, citations and backlinks, note editing in CodeMirror, the `/an trust` review view
(slice 4). Interactive plots. A kernel that survives the session. Altair capture.

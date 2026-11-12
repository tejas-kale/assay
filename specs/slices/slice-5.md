# Slice 5 spec: Assay owns the backend (the MCP server at parity)

The first of four slices agreed in a grilling session on 2026-11-02 (below, "The four slices"). This one removes
Assay's dependence on the analysis mod in `~/Code/config/claude/analysis`: everything the mod does for the app moves
into this repo as a standard Claude Code plugin (an MCP server, hooks and skills), with **the same behaviour and the
same file layout**. Later slices change the layout; this one only changes who implements it.

Read the mod's `README.md` and `HANDOFF.md` first: they are the behaviour this slice must reproduce. Where this spec
is silent, the mod's README wins.

Fixed points: assay `5eea629`, config `b2f7df2`.

## The four slices

1. **This slice.** The MCP server at parity; the mod stops being loaded, then is deleted.
2. **Root layout.** `analysis.yaml` (a typed title, the folder slug derived from it) replaces `.analysis`; Claude
   starts in the root; one-off migration; `investigations/` and `explorations/` dropped.
3. **Zettelkasten root notes.** Facts and note files merge into one note kind in `<root>/notes/`, named
   `<timestamp>-<slug>.md` and linked by timestamp ID; citations name the analysis (`[churn-q3 q 12]`); after the
   first query of a new analysis Claude searches the root notes and calls `link_notes`; the yaml lists notes found
   and written there; a new Notes tab shows them. Claude writes prose only through note tools; code and drafts stay
   in the analysis; threads stay per analysis.
4. **Trust and skills.** A skill for drafting trust proposals; resume and wrap-up rewritten for root notes.

Slice 1 must not anticipate 2–4 beyond the two seams named under "Seams for later slices".

## What the user gets

1. Assay works as today, with the mod gone from the wrapper: the same tools, runs, kernel, labels, threads, notes,
   trust review and Data/Code/History/Trust tabs.
2. The trust review is started and answered **in the app**: the Trust tab lists proposals, a **Check** button runs the
   checks, and **Trust** / **Reject** buttons appear when they pass. `/an trust` is gone.
3. `/an`, the mod's pane and the terminal-only use of the mod are gone. Assay is the only way to run an analysis.
4. The skills are `assay:resume` and `assay:wrap-up`, unchanged in content apart from tool names.

## Why trust promotion moves into this slice

The grilling put the Promote button in slice 4. But the mod's `/an trust` is a mod command that asks with
`$.ui.ask`; neither exists once the mod is gone, and an MCP tool Claude can call must never promote. So parity needs
the app-side buttons now. Slice 4 keeps only the drafting skill and the skill rewrites.

## Architecture

```
Assay (Mac, Electron)                      Podman container (the `claude` wrapper)
  spawns wrapper with                        claude
    --plugin-dir /opt/assay/plugin             ├─ plugin: hooks (UserPromptSubmit, PreToolUse, SessionEnd)
    env ASSAY_APP=1, ASSAY_ROOT,               ├─ plugin: skills (resume, wrap-up)
        ASSAY_ANALYSIS                         └─ plugin: .mcp.json → node /opt/assay/out/server/index.mjs
  writes .assay/requests/<id>.json  ───────►       MCP server "assay" (stdio, one per session)
  reads  .assay/replies, runs.json,  ◄──────         ├─ tools: sql, python, trusted, park, close, focus, order,
         trust/<name>.json                           │         note, revise_note, new_note, link_note
                                                     ├─ polls .assay/requests every 500 ms
                                                     └─ owns the kernel (analysis_kernel.py serve)
```

- **The file contract with the app is unchanged** (`.assay/requests`, `replies`, `runs.json`, `trust/<name>.json`),
  apart from the new request types under "Trust review". A direct socket between app and server was considered and
  dropped: the server is in the container and the app on the Mac, and the files already cross that boundary.
- **One server process per Claude session.** Claude Code starts it at session start and ends it at session end; its
  lifetime is the kernel's lifetime (start on server start, kill on exit, restart on `restart` or a dead kernel).
- **The plugin lives in this repo**, `plugin/`, with `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`
  and `skills/`. It is a standard plugin, not a mod: no `register.tsx`, no `$.ui`, no panes.
- **Server code** is TypeScript in `src/server/`, built by `npm run build:server` (esbuild, one ESM bundle with its
  dependencies, `out/server/index.mjs`) so the container needs no `npm install`. Pure logic goes in `src/core` so the
  app and the server share it (runs, labels, threads, note files already live there; reuse, do not fork).
- **New dependency:** `@modelcontextprotocol/sdk` (server only), `esbuild` (dev).

## Part 1: the MCP server

Port the mod's behaviour tool by tool from `hooks/register.tsx` and `hooks/model.ts`. Names drop the `analysis`
prefix: Claude sees `mcp__assay__sql` and so on.

| Tool | Behaviour (as in the mod's README, "Claude's tools") |
| :- | :- |
| `sql` | Databricks via `databricks experimental aitools tools query`, or `engine: "postgres"` via `rds-psql --csv`; saves `.sql`/`.csv`; 50 rows back; first-touch data dictionary note. |
| `python` | One kernel per session; saves `NNN_<slug>.py`, `.json`, `.tK.csv`, `.pK.png|svg`; one run at a time; 590 s interrupt. |
| `trusted` | `{ name, args }`, via `python -m analysis_trust run`; refuses an uncommitted or changed calculation. |
| `park`, `close`, `focus`, `order` | `threads.md`. |
| `note`, `revise_note` | `notes.md`, labels derived from the cited run, never by Claude. |
| `new_note`, `link_note` | `notes/NNN-<slug>.md`, unknown-run and unresolved-link warnings. |

The server also does what the mod did on activation: creates missing `notes.md`, `threads.md`, `queries/`, `notes/`,
`lib/__init__.py`, `tests/` (never overwriting), relabels old facts, and keeps `kernel.state` in `.assay/runs.json`.
It handles every request type the mod handled (`sql`, `python`, `interrupt`, `restart`, `replay`).

The analysis is `ASSAY_ANALYSIS` (an absolute path), never the cwd. The shared folder for `dictionaries/` and
`trusted/` is `ASSAY_ROOT`, replacing the mod's "nearest folder named `notes-src`". Without either, every tool
answers one line saying Assay did not start this session.

## Part 2: hooks (in `plugin/hooks/hooks.json`, one Node script each, bundled like the server)

- **UserPromptSubmit**: the mod's "Rules on each prompt", as `additionalContext`, only for typed prompts: the rule
  text, the trusted calculations list, and "Since your last turn the user ran: …". The server records user runs in
  `.assay/user-runs.json`; the hook reads and empties it.
- **PreToolUse**, `Bash`: deny Python run through Bash, with the mod's message (`bashRunsPython` moves to `src/core`).
- **PreToolUse**, `Write|Edit|NotebookEdit`: deny writes under `$ASSAY_ROOT/trusted` and `$ASSAY_ROOT/dictionaries`.
- The static parts of the rules that need no per-prompt state may go in `--append-system-prompt` (added by the app)
  instead; pick whichever keeps the hook smallest, and say which in the PR.

## Part 3: trust review

- The server runs reviews. New request types: `trust-list` (reply: proposals in `lib/trusted/` and
  `lib/dictionaries/`), `trust-check { name }` (runs `analysis_trust check … --stream`, writes
  `.assay/trust/<name>.json` after every step, ends in `asking` when all checks pass or `failed`), and
  `trust-answer { name, answer: "trust" | "reject" }`, accepted only in state `asking`.
- `trust` copies and commits exactly as the mod did (`trusted: approve <name>`, those paths alone), "Already trusted:
  no changes", and removes the drafts unless changed since the check. One review at a time.
- No MCP tool can start a check or answer one. Claude cannot promote.
- App: the Trust tab lists proposals (from `trust-list`), each with **Check**; a review in `asking` shows **Trust**
  and **Reject** (single keys too, via `PANE_KEYS`). The rest of the tab is as in slice 4.

## Part 4: the app

- `spawnSpec` adds `--plugin-dir /opt/assay/plugin` and the env `ASSAY_ROOT` (the Settings folder) and
  `ASSAY_ANALYSIS` (the open analysis). The cwd stays the analysis folder in this slice.
- Nothing else in the app changes, except the Trust tab.

## Part 5: the config repo

- `bin/claude`: when `ASSAY_APP=1`, mount `$ASSAY_DIR` (default `~/Code/assay`) at `/opt/assay:ro`, pass
  `ASSAY_ROOT` and `ASSAY_ANALYSIS` through, and drop `/opt/analysis` from `CLAUDE_CODE_PLUGIN_DIRS`. Without
  `ASSAY_APP`, the mod is no longer loaded either.
- Python helpers (`analysis_db.py`, `analysis_kernel.py`, `analysis_trust.py`, `pyproject.toml`, `uv.lock`, their
  tests) move to `python/` in this repo. `claude-pkg venv-assay` builds from `~/Code/assay/python`, mounted at
  `/opt/assay/python` so the editable install resolves. `analysis_notebook.py` stays in config (Molten on the Mac).
- **Last step, only after the Mac checklist passes:** delete `claude/analysis/` from the config repo in its own
  commit (`git show` recovers it), and update `claude/HANDOFF.md`.

## Seams for later slices

- The server reads the analysis from `ASSAY_ANALYSIS`, not the cwd (slice 2 moves the cwd to the root).
- The shared folder is `ASSAY_ROOT` (slice 2 makes it the root that holds everything).

## Tests

- Port the mod's tests (`tests/*.test.ts`) to `npm test` against `src/core` and `src/server`; port the Python tests
  under `python/tests` (scratch venv with `uv`, as `test_venv.sh` does; never touch `~/Code/notes-src`).
- New: an MCP client test (the SDK's client over stdio) that starts the bundled server on a scratch analysis with a
  stub `databricks` and a real kernel, and calls each tool once; a request-file test for each request type,
  including the three trust types and an `answer` outside `asking` (refused).
- Hook tests: feed each hook script its JSON on stdin and check the decision or context.
- `npm test`, `npm run typecheck` and `npm run build:server` must pass.

## Mac checklist (by the user, before the mod is deleted)

1. Open an analysis: kernel `idle`, a `sql` and a `python` run from Claude and one from the app.
2. A fact with `[q N]` gets its label; `new_note` writes a note the Notes tab shows.
3. Bash `python -c` is refused; a `Write` into `trusted/` is refused.
4. Trust tab: Check a proposal, Trust it, see the commit; Check and Reject another.
5. `/assay:resume` and `/assay:wrap-up` run.
6. Close the window: the kernel process is gone.

## Not in this slice

The root layout, `analysis.yaml`, titles, migration (slice 2); root notes, `link_notes`, the new Notes tab (slice 3);
the drafting skill and skill rewrites (slice 4); any change to labels, run files or the app's tabs other than Trust.

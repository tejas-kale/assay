# Slice 2b spec: trust labels, pinning, markers, editing and SQL re-runs

Finishes "Build slices" item 2 of `HANDOFF.md`. Read `HANDOFF.md` first (it wins on product intent), then the Status
section for what slice 2 already built: Data, Code and History over `queries/` (`src/core/runs.ts`,
`src/renderer/components/DataPane.tsx`, `CodeView.tsx`). `specs/slices/slice-1.md` still holds for layout of the code, IPC and tests.

## Build environment (changed since slice 1)

- Agents now run on the Mac with `node_modules` installed. `npm test` and `npm run typecheck` both work and must pass.
- New dependency allowed: `@replit/codemirror-vim` (the Vim mode for CodeMirror 6). Install with `npm install`.
- The config repo is `~/Code/config`; the mod is `claude/analysis`. Its tests: `cd ~/Code/config/claude/analysis &&
  /opt/homebrew/bin/claude plugin test .`. In the config repo commit only the files this slice touches: other files there
  hold the user's own changes.

## What the user gets

1. Every run shows its trust label (`trusted`, `queried`, `unverified`) in History and in the run header, and whether it is
   the user's run and which run it came from.
2. `p` (in Data, Code or History) and the palette's "Pin current run" hold the current run; pressing again follows Claude's
   latest. Choosing a run in History also holds it, as today.
3. Data, Code and History show a marker in their tab title when they have new content the user has not looked at.
4. In Code, `i` or Cmd+E edits the run in CodeMirror with Vim mode. Cmd+Enter runs the edited SQL as a new run. In read
   mode, Cmd+Enter re-runs the current run unchanged as a new run. Both go to the mod through a request file, so the run is
   numbered, saved and labelled exactly as Claude's `sql` tool does it.

## The contract: run headers and request files

Files stay the contract; the app keeps no database.

### Run header lines (written by the mod, read by the app)

A run the user asked for is saved by the mod with header lines before the SQL:

```
-- author: user
-- from: 012
-- postgres            (only for Postgres, as the mod already writes it)
<sql>
```

`-- from:` is present only when the run came from another run; the number is zero-padded as in the file name.
Existing headers keep their meaning: `-- trusted: <name>`, `-- commit:`, `-- args:` (trusted runs) and `-- postgres`.
A run with no `-- author:` line is Claude's.

### Request files (app writes, mod reads)

- Path: `<analysis>/.assay/requests/<id>.json`. `id` is `<Date.now() as 13 digits>-<6 random [a-z0-9]>`, so names sort by time.
- The app writes atomically: a temp file named `.<id>.json.tmp` in the same folder, then rename. The mod ignores names
  starting with `.` and names not ending in `.json`.
- Body:
  ```json
  { "id": "<id>", "kind": "sql", "sql": "<the SQL body, no header lines>", "engine": "databricks" | "postgres",
    "from": 12, "slug": "<slug of the run it came from>" }
  ```
  `from` and `slug` are optional (a run with no origin uses slug `query`). `kind` is `sql` only in this slice; slice 3
  adds Python.

### Reply files (mod writes, app reads and deletes)

- Path: `<analysis>/.assay/replies/<id>.json`, written by the mod once the run has finished (result saved or failed),
  or at once when the request is refused.
- Body: `{ "id": "<id>", "number": 13 }` when a run was made (it may still have failed: `.assay/runs.json` says why), or
  `{ "id": "<id>", "error": "<why the request was refused>" }` when no run was made (unreadable JSON, unknown kind, empty SQL).

### What the mod does

- Only when `ASSAY_APP=1` and the session is in an analysis: every 500 ms (`$.clock.every`) list `.assay/requests/`.
  Take the requests in name order, one at a time; a poll that finds the previous request still being handled does nothing.
- For each request: delete the request file first (so a crash never runs it twice), then validate, then run it through
  the same `runQuery` path as the `sql` tool, with the saved text `-- author: user\n` + (`-- from: NNN\n` when `from` is
  set) + (`-- postgres\n` for Postgres) + the trimmed SQL + `\n`, and slug `slugify(request.slug ?? 'query')`. The reply goes
  to `.assay/replies/<id>.json`. What `runQuery` returns (Claude's tool reply) is discarded.
- A user run is never `trusted`: it has no `-- trusted:` header, so `deriveLabel` gives `queried` or `unverified` as for any
  query. Do not fork `runQuery`, `deriveLabel` or the `sql` tool: reuse them.
- Telling Claude about the user's runs on the next prompt is slice 3 ("the run notice"), not this slice.

## App: core modules (pure, tested first with `node:test`)

**`core/runs.ts`** additions:

- `parseRunHeader(text): { author: 'user' | 'claude'; from?: number; trusted?: string; engine: 'databricks' | 'postgres' }`
  from the leading `-- ` comment lines. `trusted` is the `-- trusted:` name, as in the mod's `parseRunHeader` (`hooks/trust.ts`).
- `sqlBody(text): string`: the SQL with the leading header lines above removed (`-- author:`, `-- from:`, `-- trusted:`,
  `-- commit:`, `-- args:`, `-- postgres`), so a re-run or edit never copies them. Other comments stay.
- `runLabel(run, header, status): 'trusted' | 'queried' | 'unverified' | 'running'`: `running` when `status.running` names
  it; otherwise as the mod's `deriveLabel`: no `.csv` gives `unverified`; a `.csv` and a `trusted` header gives `trusted`;
  else `queried`.
- `Run` gains `author`, `from?`, `trusted?`, `engine` (filled by main from the header; see Main). Keep `parseRuns` pure over names.

**`core/requests.ts`**:

- `newRequestId(now: number, random: () => number): string` in the format above.
- `sqlRequest({ id, sql, engine, from?, slug? }): string`: the JSON text. Throws on empty SQL.
- `parseReply(text): { id: string; number: number } | { id: string; error: string } | undefined`.
- `canRerun(run, header)`: false for a Python run, and for a trusted Python calculation (body `-- python: ...`); the reason
  as a string otherwise undefined. Python re-runs come in slice 3: say "Python runs need the kernel (slice 3)".

**`core/dataTabs.ts`**: the tab markers.

- `type Seen = { number?: number; code?: string; data?: string; failed: boolean; runCount: number }`: a snapshot of the
  current run (file names) and of how many runs exist.
- `markTabs(markers: Set<'data' | 'code' | 'history'>, before: Seen, after: Seen, active): Set<...>`: Data is marked when the
  current run's data file or failure changes; Code when the current run number or its code file changes; History when the
  run count grows. The active tab is never marked, and showing a tab clears its marker. Plots is not marked in this slice.

**`core/keymap.ts`**: add `code.edit` (title "Edit current code", Cmd+E). `pin.toggle` loses `unavailable`. `code.run`
keeps Cmd+Enter. Update `PANE_KEYS`: `p` pin in Data, Code and History; `i` edit in Code; in edit mode `Esc` (normal mode)
leave, `⌘↩` run.

## App: main

- **Headers:** `loadState` fills `author`, `from`, `trusted`, `engine` on each run from the first 2 KB of its code file. Runs
  are immutable, so cache the parsed header by file name for the window's life; never re-read a known file.
- **Requests:** a new IPC call `runs.request({ sql, engine, from?, slug? }) -> { ok: true; id } | { ok: false; message }`.
  Main makes `.assay/requests/` (and `.assay/.gitignore` with `*` if missing), writes the file atomically, and returns the id.
- **Replies:** poll `.assay/replies` with the existing `pollFiles`. For each reply file: parse, delete it, and send an event
  `runs.onReply(cb)` with the parsed reply to the window. A reply for an id this window did not send is still delivered and
  deleted (the folder belongs to this window's analysis).

## App: renderer

- **Labels:** History rows and the run header show the label as the same coloured chip Notes uses (add a `running` style),
  `you` for the user's runs, and `from 012` when set. History's row text stays the slug.
- **Pin:** state `held: number | undefined` in the data pane (today's `chosen`). `p` or the palette toggles: following ->
  hold the current run; held -> follow latest. The header says `pinned` with "p: follow latest" while held. Choosing in
  History holds, as today. A held run that disappears falls back to following.
- **Markers:** the tab strip shows a small dot after a marked tab's title (`core/dataTabs.ts`). Compute on every state push
  and reply; clear on showing the tab.
- **Edit mode** in Code (`i` in the Code tab, or Cmd+E from anywhere, which also switches to Code and focuses it):
  - The editor starts from what is on screen: the formatted SQL if formatted, the original if `o` was pressed, always with
    header lines removed (`sqlBody`). The CodeMirror view gains `@replit/codemirror-vim` and drops read-only. It starts in
    Vim normal mode.
  - The header shows `editing <label>` while editing. `Esc` in Vim normal mode leaves edit mode; if the text changed, the
    header asks "Discard edits? y / n" first.
  - A new current run (Claude's latest arriving) does not replace an open edit: the editor keeps its text and its origin run.
  - `p`, `d`, `o` and the list keys do nothing while editing (Vim owns the keys).
- **Cmd+Enter (`code.run`)**: in edit mode, send the editor's text with `from` = the edited run, `slug` = its slug, `engine`
  = its engine. In read mode, re-run the current run's `sqlBody` the same way. Refused (toast with the reason) when
  `canRerun` says no, or the text is empty. On send: leave edit mode, follow latest (unpin), and show a toast
  "Sent to Claude's session…". On the reply: `error` -> warning toast with it; `number` -> nothing more (the run already shows
  through `runs.json` and the new files).
- If no reply arrives within 10 s and no run started (`runs.json` has no `running`), toast once: "The session has not picked
  up the run. Is Claude running in this window?" (the mod only polls while its session is alive).

## Tests

- App: `npm test` and `npm run typecheck`. Write the core tests first (`runs.test.ts`, `requests.test.ts`,
  `dataTabs.test.ts`, `keymap.test.ts`). Main and renderer have no unit tests; keep them thin.
- Mod: tests for the request poller in the mod's test suite: a valid request makes run N+1 with the header lines and a
  reply `{ id, number }`; Postgres keeps `-- postgres`; unreadable JSON, unknown kind and empty SQL give an `error` reply
  and no run; the request file is gone after handling; dot-files and non-`.json` names are ignored; without `ASSAY_APP=1`
  nothing is polled. If the test engine cannot advance `$.clock.every`, export the per-tick function and test it directly.

## Not in this slice

The run notice to Claude, Python runs and re-runs, Plots, Replay, the kernel, notes files, the trust review view.

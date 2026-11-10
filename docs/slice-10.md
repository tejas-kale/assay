# Slice 10 spec: overviews, blocks, include by name, retype check

Status: spec, 2026-11-10. 10a and 10b built. Written from the assay-root draft `2026-11-10-assay-review-workflow-changes.md` (the
review-workflow grilling of 2026-11-09 and 2026-11-10), after reading Assay's code.

Four slices, each usable alone, built in this order:

1. **10a, Overview tab** (about 1 day): the analysis and system overviews, a diff since the user last marked them
   read, and their line count.
2. **10b, blocks** (1 to 2 days): a new kind of trusted SQL template with a contract, checked once in the Trust tab
   with a grain check and an independent rebuild on live data.
3. **10c, include by name** (1 to 2 days): Claude's SQL names definitions and blocks, the server expands them, the run
   records what it is built from, and Steps shows each block as one labelled step.
4. **10d, retype check** (half a day to a day): the `sql` tool warns when SQL writes out a trusted piece's logic by
   hand.

## Problem Statement

The analyst checks Claude's work by reading how its SQL computes, while the defects of the inherited buyer-rating
query (v13) were in what it should compute. Two gaps in Assay feed this:

- **No home for the current picture.** What an analysis found, and how the system it studies works, is spread over
  notes, threads and chat.
- **Trusted pieces are not reused.** After the dictionary's `client_entry` filter was approved, 25 runs retyped
  `lk_responsestatusid = 3` by hand and 7 runs in total called any trusted piece. Claude can only run a trusted piece
  whole (`trusted` tool) or retype it, and most trusted calculations answer one question, so they cannot be building
  blocks.

## Decisions settled with the user (2026-11-10)

- **Park rule:** Assay's injected rule changes from "park each other question" to: answer the first question, name
  the others in one line at the end of the reply, and park a thread only for a ruling a person must make, saying who.
- **Blocks are atomic:** a block may include definitions, never another block.
- **Overview caps:** the Overview tab shows the document's line count, amber above 50. Assay does not warn Claude; the
  caps stay in Claude's rules (the workflow skill, out of scope here).
- **Order:** this spec, then 10a to 10d without stopping.

## Slice 10a: Overview tab

### Files

- `<root>/systems/<system>.md`: one per system, shared by every analysis on it (a new folder at the root).
- `analyses/<analysis>/overview.md`: one per analysis. It names its system on a line of its own among its first 5
  lines: `System: systems/<system>.md` (a leading `^ ` or `> ` is allowed, so the draft's `^ System:` works).
  `<system>` is lower case, digits and `-`.
- Claude writes both with Write and Edit (no new tool). The hooks allow writes to `systems/` (it is not guarded).
- Assay does not enforce their structure.

### Read baselines

- "Mark read" copies the document's current text to `.assay/overview-read/overview.md` or
  `.assay/overview-read/systems/<system>.md` in the open analysis (`.assay/` ignores itself). The system baseline is
  per analysis: marking it read in one analysis leaves the others' diffs alone.
- With no baseline, everything shows as new.

### The tab

- A new **Overview** tab, first in the notes pane (Overview, Threads, Notes, Files), shortcut `⌃⇧O`. `⌃2` pressed again
  inside the pane cycles Overview → Threads → Notes → Files.
- It shows the analysis overview rendered as Markdown (the note reader's renderer), or `No overview yet:
  analyses/<slug>/overview.md` when there is none.
- Header: `Analysis` or `System: <system>`, the line count (amber above 50 lines), `diff` when diff mode is on, and
  `read` when the text equals its baseline.
- Keys: `s` switches between the analysis overview and its system overview (`No system named: add "System:
  systems/<name>.md" to overview.md` when the overview names none, `No file systems/<name>.md` when it is missing);
  `d` switches diff mode; `m` marks the shown document read; `j` / `k`, `g` / `G` scroll.
- **Diff mode:** the document split into blocks (paragraphs, list items, headings, table and code blocks, separated as
  Markdown separates them), compared with the baseline's blocks by longest common subsequence. Unchanged blocks
  render as usual; removed blocks render struck through on a red tint; added blocks on a green tint. A changed
  paragraph shows as its old block removed and its new block added. With no change: `No change since you marked it
  read.`
- The state carries both documents and their baselines, so the tab follows every write as the other tabs do: main
  polls `overview.md`, the system file it names and `.assay/overview-read/`.

### Where it lives

- `src/core/overview.ts` (pure, tested): `systemOf(text)` (the system file named in the first 5 lines),
  `markdownBlocks(text)`, `overviewDiff(baseline, text)` → `{ kind: 'same' | 'added' | 'removed'; text }[]`,
  `lineCount(text)`, `OVERVIEW_LINE_CAP = 50`.
- `src/main/files.ts`: `loadState` reads both documents and their baselines into `AnalysisState.overview`;
  `markOverviewRead(analysis, which, expectedText)` writes the baseline when the file still holds `expectedText`, else
  `stale`.
- `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`: `overview.markRead(which, expectedText)`.
- `src/renderer/components/OverviewTab.tsx`; `NotesTabName` gains `overview`; the keymap gains `tab.overview`.

### Tests

- `src/core/overview.test.ts`: `systemOf` (found on line 2, with `^ `, beyond line 5 not found, a bad name);
  `markdownBlocks` (a list item per block, a fenced code block kept whole, a table kept whole); `overviewDiff` (no
  baseline → all added, unchanged, a changed paragraph → removed + added, a removed section); `lineCount`.
- `src/main` (with a temp folder): `loadState` carries the overview and its baseline; `markOverviewRead` writes the
  baseline and refuses a stale text.

## Slice 10b: blocks

### The contract

A block is a trusted SQL template (`trusted/<name>.sql`, front matter `/*--- ... ---*/` as today) whose front matter
has a `block:` mapping. YAML, not a `-- block:` comment header as the draft proposed: the front matter already carries
the description and parameters, the helper already parses it, and it keeps the contract in one place.

```sql
/*---
description: One row per client-entry session in a date range, with its buyer and outcome.
parameters:
  start: date
  end: date
block:
  grain: [session_id]
  columns:
    session_id: the session
    buyer_id: the buyer that bought the session
    entry_ts: when the respondent entered the client survey
    client_outcome: the client's status for the session (complete, terminate, over quota, dropped)
    is_dropped: true when the session was dropped (statuses 124, 301 to 303)
---*/
-- grain: session_id
SELECT ...
```

- `params -> grain -> columns`: `parameters` are the params, `block.grain` the columns identifying one row,
  `block.columns` every output column, in order, each with what it means.
- **Atomic:** the Check warns above 30 lines of SQL (the step still passes) and fails when the SQL includes a block
  (10c). A block may include definitions (10c).

### The rebuild

- `<name>.rebuild.sql` beside the block: the same contract built independently, from the front matter alone, never from
  the block's SQL. Codex writes it (the `delegate:codex` subagent); when Codex is unavailable, an Opus model in
  Copilot. Its first line says which: `-- rebuilt by: codex` or `-- rebuilt by: copilot-opus`.
- It uses the block's parameters as `:name` placeholders and returns the contract's columns.
- Assay cannot verify how it was written; the `assay:propose-trusted` skill says how to get one.

### The Check for a block (`analysis_trust.check`)

The existing steps, then three more. A block needs `live:` arguments in `<name>.test.yaml`, as any calculation with
required parameters does; fixture `cases` stay optional for a block (they are required for other templates only when
the file has them, as today).

1. `form` (as today), `transpile`, `rules` (the SQL rules).
2. `contract`: `block.grain` and `block.columns` are present and well formed; the SQL's output columns (sqlglot,
   in order) equal `block.columns`; the final SELECT's `-- grain:` line, when it has one, equals `block.grain`; the
   SQL includes no block. Its text names the contract (`params start, end -> grain session_id -> 5 columns`) and, above
   30 lines, `warning: 41 lines; a block is about 30 at most`.
3. `tests` (when the file has cases) and `live` (as today).
4. `grain`: on live data with the `live:` arguments, `rows` = distinct grain tuples (the slice 9c counts). ✗
   `grain session_id has 3 duplicate rows`.
5. `rebuild`: `<name>.rebuild.sql` exists, has a `-- rebuilt by: codex|copilot-opus` line, uses only the block's
   placeholders, and returns the contract's columns (any order). It runs on the same `live:` arguments, and the two
   results are compared as multisets of rows in the helper, both ways, with at most 10 rows of each side shown. ✓
   `block and rebuild (codex) agree: 1204 rows`; ✗ `12 rows only in the block, 3 only in the rebuild (codex)` with the
   rows. (As built: compared in Python rather than with `EXCEPT ALL` on the warehouse, so it is the same on DuckDB
   fixtures and both engines; `live:` arguments should return a few thousand rows at most.)

Approving copies `<name>.sql`, `<name>.test.yaml` and `<name>.rebuild.sql` into `trusted/` as today's files are.

### Listing and the rules

- `analysis_trust list` marks a block: it stays `kind: "sql"` (it runs as any template) and gains `block: {grain,
  columns}` (names only). The check's `start` event carries the same `block`, and the Trust tab calls it `SQL block`.
- The rules list blocks apart from calculations, each as `- client_entry_sessions(start: date, end: date) -> grain
  session_id: session_id, buyer_id, ...: <description>`.
- The `trusted` tool still runs a block whole.
- `assay:propose-trusted` learns blocks: when to propose one (about to write the same cross-table logic a second
  time), the front matter, the 30-line limit, the `live:` arguments and how to get the rebuild.

### Tests

- `python/tests/test_analysis_trust.py`: a block's contract step (passes; output columns differ; grain line differs;
  includes a block; the 30-line warning); `list` marks a block; the grain and rebuild comparisons (a fake engine:
  agree, rows on one side only, both sides, a missing or unsigned rebuild).
- `src/core`: the rules line for a block; `parseCalculationList` keeps `grain` and `columns`.

## Slice 10c: include by name

### Syntax

- **Block:** the whole body of a CTE: `sessions AS ({{ client_entry_sessions(start => '2026-11-01', end =>
  '2026-11-08') }})`. Arguments are literals, by name (`p => value`) or in declared order; checked and converted against
  the block's declared types, as the `trusted` tool does.
- **Definition:** any expression position, with the alias of the table it applies to:
  `WHERE {{ client_entry(s) }}`, or `{{ vw_sessions_lc_by_entrydate:client_entry(s) }}` when the short name is not
  unique among definitions. It expands to its expression in parentheses with each unqualified column qualified by the
  alias: `(s.lk_responsestatusid = 3)`. A metric or derived definition expands the same way (`{{ return_rate(s) }} AS
  return_rate`).
- Unknown names, wrong arguments, a block outside a CTE body, a definition without an alias, and a piece that differs
  from its commit (dirty) reject the query: `Not run: ...` with one line per problem; no number is claimed.

### Expansion: `analysis_sql expand <dialect> <root>`

SQL on stdin; prints JSON:

```json
{"sql": "<expanded SQL, which runs>",
 "lint_sql": "<the SQL as written, each block body replaced by SELECT <its columns> FROM <block name>, each definition by its expansion>",
 "built_from": [{"name": "client_entry_sessions", "kind": "block", "commit": "1a2b3c4d5e6f"},
                {"name": "vw_sessions_lc_by_entrydate:client_entry", "kind": "definition", "commit": "..."}],
 "blocks": [{"cte": "sessions", "name": "client_entry_sessions"}]}
```

or `{"errors": [...]}`. SQL without `{{` comes back unchanged with empty lists. A block's body is its template with the
placeholders replaced by the literals (sqlglot, in the dialect); a body that has CTEs is nested as a `WITH` inside the
CTE (both Databricks and Postgres accept it).

### The server

- `runSql` (every SQL run: Claude's, the user's edits and re-runs, replays) expands first when the SQL has `{{`.
- The run's `.sql` keeps the SQL as written, under a header line `-- built from: client_entry_sessions@1a2b3c4d5e6f,
  vw_sessions_lc_by_entrydate:client_entry@...`. The expanded SQL is saved as `queries/NNN.expanded.sql` (never a run:
  the number is followed by a dot) and is what runs.
- Claude's lint (9a) runs on `lint_sql`, so a block's internals are never linted again and the CTE that holds it is a
  plain one-source select.
- The reply's first line gains `Built from: client_entry_sessions (block), vw_sessions_lc_by_entrydate:client_entry
  (definition).` The list is generated from the expansion, never written by Claude.
- `parseRunHeader` reads `builtFrom` from the header; the Code tab shows the SQL as written (the header line included)
  and `x` switches to the expanded SQL.

### Steps and lineage

- `lineage` and `steps` read the expanded SQL when the run has `NNN.expanded.sql`, with `--blocks
  sessions=client_entry_sessions`.
- A block's CTE is one step labelled `block client_entry_sessions`, with the grain check from its `-- grain:` line; its
  joins are not listed or checked (they were checked once in the Trust tab), and the lineage draws it as one node
  (`[[...]]`, labelled `block <name>` and its grain) without the tables inside it.
- This replaces 9c's skip only for runs with includes; trusted runs keep their note.

### Tests

- `python/tests/test_analysis_sql.py`: expand a block (named and positional arguments, a date, a block used twice), a
  definition (short and full name, ambiguous short name, missing alias), unknown names, wrong arguments, a block
  outside a CTE, `lint_sql`'s stub, `built_from`, a block whose body has a CTE; `steps` and `lineage` with `--blocks`.
- `src/server`: a run with includes saves the SQL as written with the header, saves `NNN.expanded.sql`, runs the
  expanded file and replies with `Built from:`; a rejected expansion claims no number; the lint reads `lint_sql`.
- `src/core`: `parseRunHeader` reads `builtFrom`.
- End to end (server test with fake query results): a query including two blocks runs, lists both under "built
  from", and its steps show both as labelled block steps with grain checks.

## Slice 10d: retype check

### What is flagged

A warning (the query runs), on Claude's `sql` calls, computed on the SQL as written with includes removed (so an
include is never flagged):

- **Definition:** in a `SELECT` reading the definition's table (matched by full name, or by its last part when the SQL
  names the table without catalog and schema), a `WHERE`, `ON` or `HAVING` conjunct set that contains every conjunct
  of a filter definition's expression, or a projection equal to a metric's or derived value's expression, compared
  after sqlglot normalisation with the columns' table qualifiers removed. `- retypes
  vw_sessions_lc_by_entrydate:client_entry (lk_responsestatusid = 3): include {{ client_entry(<alias>) }}`.
- **Block:** a `SELECT` that joins the same source tables on the same key pairs as a block's SQL. `- retypes block
  client_entry_sessions (the join of sessions and buyers on buyer_id): include {{ client_entry_sessions(...) }}`.
- **Silenced:** a comment `-- retype: <piece>: <reason>` anywhere in the statement silences that piece's warning.

### Where it lives

- `analysis_sql retype <dialect> <root>`: SQL on stdin, prints `{"warnings": [...]}`. The server runs it with the lint,
  on `lint_sql` with definitions removed from it (`lint_sql` keeps the block stubs).
- The reply lists the warnings under `Retyped trusted logic:`, after the SQL rule warnings.
- The run's warnings (SQL rules and retypes) are saved as `queries/NNN.notices.json` (`{"rules": [...], "retype":
  [...]}`), and the Code tab shows them above the code, dim amber.

### Tests

- `python/tests/test_analysis_sql.py`: the client-entry filter retyped (bare table, aliased, in `ON`), not flagged when
  included, silenced by `-- retype:`, a different predicate not flagged, a metric retyped, a block's join retyped, the
  same tables on other keys not flagged.
- `src/server`: the warning reaches the reply and `NNN.notices.json`.
- Real positives: the runs in assay-root that retype the client-entry filter (`grep -l -E "lk_responsestatusid\s*=\s*3"
  analyses/*/queries/*.sql`), checked by hand once the slice is built.

## Rules in Assay's injected prompt

- The trusted line becomes: `Trusted pieces: include definitions and blocks by name in your SQL ({{ name(args) }} as a
  CTE body for a block, {{ name(alias) }} in an expression for a definition); Assay expands them and lists what the run
  is built from. Do not retype their logic; when you are about to write the same cross-table logic a second time,
  propose a block with assay:propose-trusted.` followed by the blocks, then the definitions and the calculations.
- The park rule as settled above.

## Out of scope

- Writing the overviews, the workflow skill, and sorting the 16 trusted calculations: Claude's work in assay-root.
- Spec files, the simulation, the backtest, the reference sheet.
- Enforcing overview structure or caps.

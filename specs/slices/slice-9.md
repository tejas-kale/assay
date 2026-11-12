# Slice 9 spec: readable SQL (rules, lineage, steps)

Status: slices 9a, 9b and 9c built (need `claude-pkg venv-assay` for `analysis_sql`).

Agreed in a grilling session on 2026-11-05. It comes from advice on reading complex SQL: think in grain, know each
join's cardinality, read top-down and verify bottom-up, sketch the lineage. Three slices, each usable on its own:

1. **9a, rules** (about half a day): the `sql` tool rejects Claude's CTE and JOIN queries that lack grain and
   cardinality comments, have cryptic CTE names, or nest subqueries.
2. **9b, lineage** (about a day): a new **Steps** tab draws the selected run's CTE graph.
3. **9c, steps** (2 to 3 days): the Steps tab runs every CTE, shows each result as it finishes and checks the
   declared grain and cardinality.

## Problem Statement

Claude writes multi-CTE queries with names like `w` and `ow`, no word on what one row of each CTE is, and joins whose
cardinality is unstated. The analyst has to hold the whole query in their head to trust its numbers, and many:many
joins inflate sums without anyone noticing. Nothing in the app shows a query's structure or lets the analyst check
one CTE at a time.

## The comment format (shared by all three slices)

Fixed so the server can parse and verify it:

```sql
WITH
-- grain: customer_id, order_date
daily_spend AS (
  SELECT o.customer_id, o.order_date, SUM(l.amount) AS spend
  FROM orders o
  -- join: 1:many on order_id
  JOIN order_lines l ON l.order_id = o.order_id
  GROUP BY o.customer_id, o.order_date
)
...
```

- `-- grain: <col>[, <col>...]`: the line directly above `<name> AS (`. The columns are the CTE's output columns that
  together identify one row.
- `-- join: <1:1|1:many|many:1|many:many> on <key>[, <key>...]`: the line directly above each `JOIN`. Left side
  first: `1:many` means one row on the left matches many on the right.
- The final `SELECT` takes a `-- grain:` line too, directly above it.
- `-- grain: none` declares a result of exactly one row (a total with no `GROUP BY`).

## Existing trusted calculations and the dictionary

- **Trusted SQL calculations already trusted:** no bulk migration. They run as vetted, without comments. A
  calculation is brought up to the rules only when it is next changed: its new proposal must pass the lint at Check.
  Until then, Steps (9c) draws its lineage without labels and skips its ✓/✗ checks.
- **Dictionary definitions** (SQL that `render_definition` generates): the renderer writes the grain line itself.
  - metric or filter with `by`: `-- grain: <by columns>`.
  - metric or filter without `by`: `-- grain: none`.
  - derived: no grain line, because `by` only picks the columns shown and the YAML records no table key. Steps skips
    the grain check for it.
  - They are single-table statements with no CTE or JOIN, so the lint never runs on them.

## Slice 9a: rules

### Scope

- **Checked:** Claude's `sql` tool calls whose statement has a `WITH` or a `JOIN`. A plain one-table query passes
  unchecked.
- **Not checked:** the analyst's own runs (Code and Trust tab Cmd+Enter, replays) and vetted trusted calculations.
- **Trusted proposals:** the Trust tab's Check runs the same lint on a SQL calculation's template and fails on a
  rejection.

### Rejections (the query does not run)

1. A CTE or the final `SELECT` without a `-- grain:` line, or a grain column that is not one of its output columns.
2. A `JOIN` without a `-- join:` line (`CROSS JOIN` included; the comment is then `-- join: many:many on none`).
3. A CTE name shorter than 4 characters, or matching `^(step|cte|tmp|temp|t|q|sub)_?\d*$`. Names say what the CTE
   holds (`orders_per_customer`), not what it does.
4. A subquery in `FROM` or `JOIN` (`FROM (SELECT ...) x`). It must be a CTE. Scalar and `IN`/`EXISTS` subqueries in
   `SELECT`, `WHERE` and `HAVING` stay allowed.

### Warnings (the query runs; the reply lists them)

5. A CTE that does more than one of filter, join, aggregate (filter here means `WHERE` on a CTE that also joins or
   aggregates; `WHERE` on a single-source `SELECT` is just the filter job).
6. A `JOIN` whose declared side is `many` feeding a `SUM`, `COUNT` or `AVG` in the same CTE: aggregate before joining.

### Reply shapes

- Rejected: `Not run: the query breaks the SQL rules. Fix and send again:` then one line per problem, naming the CTE or
  the join's line, e.g. `- CTE ow: no "-- grain:" line above it.` / `- CTE ow: name too short; say what it holds.`
- Run with warnings: the usual reply, then `SQL rule warnings:` and one line each.

### Where it lives

- `python/analysis_sql.py` (new, built into venv-assay, sqlglot): `lint(sql, dialect) -> {"errors": [...],
  "warnings": [...]}`, and `python -m analysis_sql lint` reading SQL on stdin, printing JSON. Dialect `databricks` or
  `postgres` from the call's engine. Comments: check first whether sqlglot keeps them on the CTE and JOIN nodes; if
  not, scan the tokenizer's comment tokens by position.
- `src/server/assay.ts` `runSql`: before claiming a run number, lint when the SQL has `WITH` or `JOIN`; on errors,
  return the rejection without recording a run. A lint that cannot run (venv missing, parse error) does not block:
  the query runs and the reply says the lint was skipped and why.
- `src/server/tools.ts`: the `sql` tool description gains the comment format and the rules in two or three lines, so
  Claude writes them first time.
- `analysis_trust.check`: calls `analysis_sql.lint` on a SQL template (placeholders bound to dummy literals first).

### Tests

- `python/tests/test_analysis_sql.py`: each rejection and warning, a passing multi-CTE query, a plain query, scalar
  `IN (SELECT ...)` allowed, both dialects.
- `src/server`: a rejected `sql` call records no run and claims no number; a passing call runs; a warning reaches the
  reply; a lint failure does not block.

## Where 9b and 9c run

sqlglot lives only in venv-assay, inside Claude's container, so the app (on the Mac) cannot parse SQL itself. Both
slices go through the server with the usual request files: the Steps tab writes a request, the server writes files
next to the run in `queries/`, and the app draws what it finds there. Like every request, they are answered only
while Claude's session runs; with no reply after `PICKUP_MS` the tab says `No reply: Steps needs Claude's session
running.`

New files in `queries/` never match `parseRuns`' `^\d+_` (the run's number is followed by a dot), so they are not
runs, take no number, and `nextRunNumber` and the kernel's `q(N)` glob ignore them:

| File | Slice | What |
| --- | --- | --- |
| `NNN.lineage.json` | 9b | run N's lineage, or why there is none |
| `NNN.steps.json` | 9c | run N's step plan, each step's status, counts and checks |
| `NNN.k_<name>.sql`, `.csv` | 9c | step k's preview query and its first 50 rows |
| `NNN.k_<name>.counts.sql` | 9c | step k's counts query (its one result row is in `NNN.steps.json`) |

Which runs get them: SQL runs only (Claude's, the user's and trusted ones). A Python run's Steps tab says `Steps
reads SQL runs.` A trusted run whose body is `-- python:` says the same.

## Slice 9b: lineage

### `analysis_sql lineage`

`python -m analysis_sql lineage <databricks|postgres> [<sql-file>]`, SQL on stdin without a file, prints JSON:

```json
{
  "nodes": [
    {"id": "shop.sales.orders", "kind": "table", "name": "shop.sales.orders"},
    {"id": "shop.sales.order_lines", "kind": "table", "name": "shop.sales.order_lines"},
    {"id": "daily_spend", "kind": "cte", "name": "daily_spend", "grain": ["customer_id", "order_date"]},
    {"id": "final", "kind": "final", "name": "Final SELECT", "grain": []}
  ],
  "edges": [
    {"from": "shop.sales.orders", "to": "daily_spend"},
    {"from": "shop.sales.order_lines", "to": "daily_spend", "join": {"cardinality": "1:many", "keys": ["order_id"]}},
    {"from": "daily_spend", "to": "final"}
  ]
}
```

- **Nodes:** each source table once (by its full name as written; `id` is the name lower-cased, dots kept), each
  CTE, and the final SELECT (`id` `final`; a CTE literally named `final` gets `id` `final_select` for the final).
  Nodes are listed in dependency order: tables first in order of first use, then CTEs in the order they are
  written, then the final SELECT.
- **grain** (CTEs and the final SELECT only): the columns on its `-- grain:` line, `[]` for `-- grain: none`, absent
  when there is no grain line (the analyst's runs, untouched trusted SQL).
- **Edges:** one per source a CTE or the final SELECT reads, from the source to the reader. The source in `FROM` has
  no `join`; each `JOIN`'s source has `join` with the declared cardinality and keys from its `-- join:` line, or
  `"join": {}` when the join has no (well-formed) line. A source read only inside a scalar, `IN` or `EXISTS`
  subquery, or inside a subquery in `FROM`, is an edge without `join`. Two joins of the same source give two edges.
- Only the last statement is read; a run with more than one says so in `"note"`.
- A trusted run's SQL is bound with `bind_dummies` first (the server does this; see below).
- A statement that does not parse prints `{"error": "the SQL does not parse: ..."}` as `lint` does.

### The server

- New request kind `lineage` (`{"kind": "lineage", "run": N}`), urgent (taken at once, like the trust requests:
  it takes well under a second and should not wait behind a long query).
- `Assay.lineage(number)`: finds run N in `queries/`, refuses a run that is not SQL or a trusted `-- python:` run,
  reads the body with `codeBody`, binds placeholders with `bind_dummies` (done inside `analysis_sql lineage` when
  passed `--template`, so the server need not port the regex), runs `analysis_sql lineage <engine>` with the run's
  engine (`-- postgres` header), and writes `queries/NNN.lineage.json` atomically: the lineage, or
  `{"error": "..."}`. The reply is `{ok: true}`, or `{error}` when the run does not exist.
- Requests in `src/core/requests.ts` (`RunRequest`, `parseRunRequest`, `ServerRequest`, `parseRequestFile`,
  `isUrgent`) gain the kind, with `run` checked by `isRunNumber` / `isIndex`.

### The app

- `src/main/files.ts` `readRun` adds `lineage?: Lineage | { error: string }` to `RunView` when the file exists
  (`parseLineage` in `src/core/lineage.ts` reads it safely, as `parseRunResult` does).
- `src/core/lineage.ts` (pure, tested): `Lineage` types, `parseLineage`, and `lineageMermaid(lineage, marks?)`, the
  Mermaid text:
  - `flowchart LR`; node ids `n0`, `n1`, ... by position, never the table or CTE name.
  - Labels quoted, with `"` written `#quot;`: a table shows its name; a CTE its name and `grain: a, b` (or
    `grain: one row` for `[]`, nothing when absent); the final SELECT `Final SELECT` and its grain.
  - Tables are drawn as stadiums `(["..."])`, CTEs and the final SELECT as boxes.
  - Edge labels: `1:many on order_id`; `join: no line` for `{}`; none for a `FROM` source.
  - `marks` (9c) maps node index to `ok`, `bad`, `running`, `skipped` and adds `classDef` lines and a
    `class nK <mark>` per marked node (ok green border, bad red border and fill tint, running dashed, skipped dim),
    colours from the theme passed in.
- A new **Steps** tab, after History (`DataTabName` gains `steps`; `DATA_TABS` and the tab keymap gain it with the
  next free shortcut). It shows the current run, as Data and Code do, with the same `RunHeader` (pin, `,` `.`).
  - SQL run with `lineage`: the diagram with the existing `MermaidDiagram`. When the lineage has no CTE and no join
    edge: `One table, no CTE: nothing to draw.` A `note` shows dim above the diagram.
  - SQL run without `NNN.lineage.json`: sends the `lineage` request once per run per window and shows `Reading
    the query…`.
  - `lineage.error`: shown as a warning line, with the run's SQL below it.
- `markTabs` does not mark Steps.

### Tests

- `python/tests/test_analysis_sql.py`: lineage of the spec's example; a table used in two CTEs is one node; two
  joins of one table give two edges; a join without a line gives `join: {}`; grain absent / `[]` / columns; an `IN`
  subquery's table is an edge without `join`; a CTE named `final`; `--template` binds `:placeholders`; both
  dialects; a parse error.
- `src/core/lineage.test.ts`: `parseLineage` drops malformed nodes and edges; `lineageMermaid` ids, quoting of a
  name with `"`, labels, stadiums, marks.
- `src/core/requests.test.ts`: the `lineage` kind both ways, urgent.
- `src/server`: a `lineage` request writes the file from the helper's answer, a missing run replies with an error, a
  Python run writes `{error}`, the engine follows the header, a trusted SQL run passes `--template`.

As built: the Steps tab is `⇧⌘S`; `stepsView` in `src/core/lineage.ts` decides what the tab shows (testable apart from the
component); `lineageMermaid(lineage, marks?, colors?)` takes the theme's `good`, `bad` and `dim` colours for 9c. Small
deviations: the example's node ids are the full lower-cased names (as the Nodes rule says, the example had short ones), and
a run that got no reply within `PICKUP_MS` is asked again on the next visit instead of never.

## Slice 9c: steps

### The plan: `analysis_sql steps`

`python -m analysis_sql steps <dialect> [--template] [<sql-file>]` prints the lineage (as above) plus `steps`, the
queries the server runs, all generated by sqlglot in the run's dialect:

```json
{"lineage": {...}, "steps": [
  {"k": 1, "name": "daily_spend", "node": 2,
   "preview": "WITH daily_spend AS (...) SELECT * FROM daily_spend LIMIT 50",
   "counts": "WITH daily_spend AS (...) SELECT (SELECT COUNT(*) FROM daily_spend) AS assay_rows, ...",
   "grain": ["customer_id", "order_date"],
   "joins": [{"j": 1, "source": "order_lines", "declared": "1:many", "keys": ["order_id"]}]}
]}
```

- One step per CTE in dependency order (the order written, which SQL requires), then a last step `final` for the
  final SELECT. `node` is the step's index in `lineage.nodes`.
- `preview`: `WITH <the CTEs this one needs, transitively, in written order> SELECT * FROM <cte> LIMIT 50`. The
  final step has no preview (`null`): run N's own `.csv` is its rows.
- `counts`: one row, the same `WITH` and then scalar subqueries, each column named `assay_*`:
  - `assay_rows`: `COUNT(*)` of the step's result. For `final` the final SELECT is wrapped as one more CTE,
    `assay_final AS (<final select>)`.
  - `assay_grain_rows`: the count of distinct grain tuples, `SELECT COUNT(*) FROM (SELECT DISTINCT <grain> FROM
    <step>)` (NULL counts as a value, and it works in both dialects). Absent with no grain line, with
    `grain: none` (then the check is `assay_rows = 1`), or with an output `*`.
  - Per checked join j: `assay_j<j>_left_rows`, `assay_j<j>_left_keys`, `assay_j<j>_right_rows`,
    `assay_j<j>_right_keys`: each side's row count and its count of distinct key tuples, read from the side's
    relation as named in the `FROM` / `JOIN` (a CTE, or the source table itself, before this CTE's `WHERE`).
- A join is checked when its `-- join:` line is well formed, it is not a `CROSS JOIN`, and its `ON` is an `AND` of
  column equalities, each between a column of the joined source and a column of exactly one other source in the
  same `SELECT` (that source is the left side), or `USING (...)` when the `SELECT` has one `FROM` source and no
  earlier join. Otherwise the join is listed with `"checked": false` and a `reason`, and its edge is never ✗.
- Not planned (`steps: []` and a `note`): a statement with no CTE, a recursive CTE, set operations
  (`UNION` ...) in the final SELECT (their CTEs are still steps; the final step counts rows only).

### The server

- New request kind `steps` (`{"kind": "steps", "run": N}`), not urgent: it queues with the other runs.
- `Assay.runSteps(number)`:
  1. Refuses as `lineage` does. A trusted run: writes the lineage only and a `NNN.steps.json` with
     `"note": "Steps run only SQL written in the run: a trusted calculation's arguments are not replayed."`
  2. Removes the run's earlier step files and `NNN.steps.json` (a request always re-runs).
  3. Gets the plan from `analysis_sql steps`, writes `NNN.lineage.json` from it, and writes `NNN.steps.json`
     with every step `pending`.
  4. For each step in order: marks it `running`, writes `NNN.k_<name>.sql` (with the run's `-- postgres` mark when
     it has one) and runs it with `Assay.queryCommand` (saving `.csv` as `runQuery` does), then
     `NNN.k_<name>.counts.sql` and its one row. Rewrites `NNN.steps.json` atomically after each change, so the app
     shows each step as it finishes. A step that fails is `error` with the message; every step after it is
     `skipped`.
  5. Computes the checks (`stepChecks` in `src/core/steps.ts`), writes them into each step, and appends one line
     per ✗ to `.assay/step-notices.json`.
- `NNN.steps.json`:

  ```json
  {"run": 42, "status": "running|done|error", "note": "...",
   "steps": [{"k": 1, "name": "daily_spend", "node": 2, "status": "pending|running|ok|error|skipped",
              "error": "...", "rows": 120, "counts": {"assay_rows": "120", ...},
              "checks": [{"kind": "grain", "ok": true, "text": "grain customer_id, order_date: 120 rows, 120 distinct"}]}]}
  ```

  (plan fields `grain` and `joins` are copied into each step so the app needs only this file and the lineage).
- Step runs do not touch `.assay/runs.json`, `failures` or the run numbers.

### The checks (`src/core/steps.ts`, pure, tested)

- **Grain:** ✓ when `assay_rows = assay_grain_rows`; ✗ `grain customer_id has 3 duplicate rows` (rows minus
  distinct). `grain: none`: ✓ when `assay_rows = 1`, ✗ `grain none (one row) has 7 rows`. No grain line: no check.
- **Join j:** a side is observed `1` when its rows equal its distinct keys, else `many`. ✗ when a side declared `1` is
  observed `many`: `join order_lines declared 1:many but the left side repeats order_id (40 rows, 31 keys)`. A side
  declared `many` that is observed `1` is ✓ with the note `(observed 1:1)`. Unchecked joins: no check, their reason
  shown dim.
- A step's mark: `bad` when any check is ✗, else `ok` once it ran; `running`, `skipped`, `error` (drawn as `bad`)
  as its status says.

### Telling Claude

- `.assay/step-notices.json`: a list of lines, appended by the server as `user-runs.json` is, each
  `q042 step spend_per_customer: grain customer_id has 3 duplicate rows.` (`queryLabel` for the number).
- The UserPromptSubmit hook takes it as it takes `user-runs.json` (renamed away, read, removed), and the notice
  gains `Step checks failed since your last turn:` followed by the lines.

### The app

- `src/core/steps.ts` also has `parseSteps` (reads `NNN.steps.json` safely) and `stepFiles(names, number)` (the
  step `.sql`, `.csv` and `.counts.sql` names in `queries/` by k).
- `readRun` adds `steps?: StepsFile` and, with `options.step = k`, `stepTable` (the step's `.csv` parsed like a run's
  table; for `final`, run N's own table).
- `Run` gains `steps?: number` (how many steps have a `.csv` or are planned, from `NNN.steps.json` when present, in
  `withResults`). History shows it in the run's dim summary: `sql + csv + 4 steps`.
- The Steps tab, below the diagram (which now gets `marks`):
  - With no `NNN.steps.json`, it sends `steps` once per run per window when the tab opens on it (replacing 9b's
    `lineage` request for SQL runs; `lineage` stays for the trusted-run case and as the fallback when the plan is
    `steps: []`). A run that is a step plan's `note` shows the note.
  - The selected step (first by default; `j` / `k` and clicking its box move it; clicking a table node does
    nothing): one line `step k of n: <name> · <status>`, its check lines (✓ green, ✗ red, unchecked dim), and its
    preview rows in the same grid as the Data tab (read only, 50 rows).
  - `r` re-runs the steps (sends `steps` again); while running, the header says `running step k of n`.
  - Clicking a box: `MermaidDiagram` gains an `onNodeClick(id)` prop: a click handler on its container finds the
    nearest `g.node` and reads our `nK` id from mermaid's element id (`flowchart-nK-<i>`), so strict mode stays on.

### Kernel

- `q(N, step=k)` loads step k's `.csv` (`step` may also be the step's name). `step` for the `final` step loads run
  N's own csv. A missing step raises `LookupError("Run 042 has no step 3")`. (`q(N.k)` with a float is not used:
  `42.10` and `42.1` would be the same number.)
- `analysisRules`' `q(N)` line gains `, or step k of a SQL run's Steps with q(N, step=k)`.

### Tests

- `python/tests/test_analysis_sql.py`: a three-CTE plan in dependency order with only the needed CTEs in each
  `WITH`; the final step's counts wrap the final SELECT; grain counts; `grain: none`; join columns for `ON` and
  `USING`; unchecked joins (cross, non-equality, three sources) with reasons; recursive CTE and no-CTE notes; both
  dialects' generated SQL parses back; `--template`.
- `python/tests/test_analysis_kernel.py`: `q(N, step=k)`, by name, `final`, missing step.
- `src/core/steps.test.ts`: `stepChecks` (grain ✓ ✗, none, join ✓ ✗, many observed 1, unchecked), marks,
  `parseSteps`, `stepFiles`.
- `src/server`: `steps` writes pending then each step in order with fake query results, stops and skips after a
  failing step, re-running removes the old files, a ✗ reaches `.assay/step-notices.json`, a trusted run writes the
  note only, run numbers and `runs.json` untouched.
- `src/hooks/hooks.test.ts`: the notice carries the step lines and empties the file.

As built: step files are `NNN.k_<name>.*` with `<name>` made file-safe (`stepSlug`: anything but letters, digits, `_`, `-`
becomes `_`), and `q(N, step=name)` applies the same rule. Small deviations: `stepsView` takes the steps file and returns
`plan` and `marks` on the diagram; `stepsRequest` (in `src/core/lineage.ts`) decides what the tab sends (`steps`, or
`lineage` for a trusted run with no lineage yet); a plan that does not parse writes the lineage `{error}` and a steps
file with `"status": "error"`; checks are written into each step as it finishes (the ✗ lines go to
`.assay/step-notices.json` as each step finishes, so a stopped server keeps them); every join in a step's SELECT is listed (`j` counts all of them), the
checked ones with no `checked` field; `stepChecks` also words a passing join as `join order_lines 1:many on order_id:
left 31 rows, 31 keys; right 40 rows, 36 keys`, with `(observed 1:1)` when it differs from the declared cardinality; and
the dim reasons for unchecked joins come from `uncheckedLines`, apart from `stepChecks`. A joined source's name in the plan
is the bare table name (`lines` for `shop.lines`). The `steps` request replies once every step has run (the file shows
progress meanwhile). Not verified by running the app: the Steps tab UI (diagram clicks, grid, `r`).

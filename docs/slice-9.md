# Slice 9 spec: readable SQL (rules, lineage, steps)

Status: slice 9a built (needs `claude-pkg venv-assay` for `analysis_sql`); 9b and 9c outlined, each to be specced after the one before ships.

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

## Slice 9b: lineage (outline)

- `analysis_sql lineage`: the CTE graph from sqlglot (nodes: source tables, CTEs, final SELECT; edges: dependencies,
  labelled with the `-- join:` cardinality; nodes labelled with `-- grain:`).
- A new **Steps** tab in the bottom pane renders it for the selected SQL run with the existing `Mermaid` component.
  A run without CTEs shows a one-line note.

## Slice 9c: steps (outline)

- **Running:** the first time Steps opens on run N, the server streams every CTE in dependency order, sources first:
  `WITH <upstream CTEs> SELECT * FROM <cte> LIMIT 50` plus one counts query (`COUNT(*)`, `COUNT(DISTINCT <grain>)`,
  and per join the observed cardinality). Each step appears as it finishes.
- **Storage:** step runs are `queries/NNN.k_<cte>.sql/.csv` (k is the step's position), recorded like every run.
  Main run numbers stay contiguous. History nests them under N. `q(N.k)` loads one in the kernel.
- **Cached:** reopening reloads the saved steps; a pane key re-runs them.
- **Navigation:** clicking a box in the diagram or j/k selects a step; the table below shows its rows, counts and
  checks.
- **Checks:** ✓ when COUNT(*) = COUNT(DISTINCT grain) and observed cardinality matches the declared one; ✗ in red
  otherwise. A ✗ goes to Claude in the next prompt's notice, e.g.
  `q42 step spend_per_customer: grain customer_id has 3 duplicate rows.`

# 03: Rich row for `sql` calls (tracer bullet)

**What to build:** in Ghostty, each `mcp__assay__sql` call shows its full SQL highlighted, its run number and author,
and the first 10 rows of its result with the full row and column counts, or its error, without pressing ctrl+o. This
lands the row model, the mod in Assay's plugin and its test in `npm run check`. Spec: `specs/rich-conversation.md`.

**Blocked by:** 01 (spike and security review), 02 (`assay open`).

**Status:** implemented — automated checks passed; live Ghostty acceptance deferred

- [x] A pure core row-model function turns a tool call plus its run files (as text) into a row model; tested with node:test for a long result, a failed run, a running call, missing files and a result with no run number.
- [x] The mod ships in Assay's plugin, loads with every Assay session and no other, and is versioned with Assay.
- [x] The mod reads run files only inside the open analysis's `queries/`.
- [x] A running call says it is running; missing or unreadable run files fall back to Claude Code's own row.
- [x] With ctrl+o the engine's own row shows first, the rich parts below it.
- [x] The mod's module is tested with `claude plugin test`, mounting a `ToolUse` row on the terminal and desktop surfaces; the test runs in `npm run check` and meets the coverage bar.
- [x] Rows fit the terminal's width.

The user deferred ticket 01 and 02 live acceptance on 2026-11-12 so implementation may proceed.
Mounted tests verify terminal and desktop SQL trees, running SQL, engine-row preservation and linked-folder refusal.
Installed Claude Code 2.1.323 exposes optional isExpanded. Expanded rows preserve the engine row first;
compact rows draw rich content alone. Surfaces omitting expansion state preserve the engine row as a fallback.
The core row model meets the per-file 90% line and branch coverage bar. `test:mod` builds the shared pure model before running
`claude plugin test plugin`; it is part of `npm run check`. Hand-written plugin source is linted and measured through the exported registration boundary, with the same per-file 90% line and branch gate. Real Ghostty painting remains a manual trial.

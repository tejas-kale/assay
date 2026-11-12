# 03: Rich row for `sql` calls (tracer bullet)

**What to build:** in Ghostty, each `mcp__assay__sql` call shows its full SQL highlighted, its run number and author,
and the first 10 rows of its result with the full row and column counts, or its error, without pressing ctrl+o. This
lands the row model, the mod in Assay's plugin and its test in `npm run check`. Spec: `specs/rich-conversation.md`.

**Blocked by:** 01 (spike and security review), 02 (`assay open`).

**Status:** ready-for-agent

- [ ] A pure core row-model function turns a tool call plus its run files (as text) into a row model; tested with node:test for a long result, a failed run, a running call, missing files and a result with no run number.
- [ ] The mod ships in Assay's plugin, loads with every Assay session and no other, and is versioned with Assay.
- [ ] The mod reads run files only inside the open analysis's `queries/`.
- [ ] A running call says it is running; missing or unreadable run files fall back to Claude Code's own row.
- [ ] With ctrl+o the engine's own row shows first, the rich parts below it.
- [ ] The mod's module is tested with `claude plugin test`, mounting a `ToolUse` row on the terminal and desktop surfaces; the test runs in `npm run check` and meets the coverage bar.
- [ ] Rows fit the terminal's width.

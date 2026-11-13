# 04: Rich row for `python` calls, with plots

**What to build:** each `mcp__assay__python` call shows its full code highlighted, its run number and author, its
tables' first 10 rows, its printed output or error, and its plots as images. Spec: `specs/rich-conversation.md`.

**Blocked by:** 03 (SQL rich row).

**Status:** implemented — automated checks passed; live Ghostty trial deferred

- [x] Tables show their first 10 rows with full counts, in K order.
- [x] Plots draw as images in Ghostty, and as their file names where the terminal cannot draw images.
- [x] Row-model and mod tests cover a run with tables and plots, one with only output, and a failed run.

Core tests cover output, failures, missing results and K ordering. Mounted terminal/desktop tests validate PNG Image elements and filename fallback. Actual Ghostty image drawing remains pending; Image uses a checked `{ file, format: "png" }` source and explicit cell dimensions.

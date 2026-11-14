# 03: Run automatic step counts on `sql` calls with a spec id

**What to build:** the `sql` tool accepts an optional `spec` id, stores it on the run, skips step counts for exploration
runs (no `spec` id), automatically runs the per-step row-count pass when a query with a `spec` id finishes, and marks
runs whose `spec` id was not in the current frozen preface without blocking execution. Spec:
https://github.com/tejas-kale/assay/issues/9#issuecomment-6879918940.

**Blocked by:** 01 (Freeze and reset the preface from the Overview tab), 02 (Stamp each run with the current preface identity).

**Status:** ready-for-agent

- [ ] The `sql` tool accepts an optional `spec` id argument and records it on the saved run and parsed run metadata.
- [ ] A `sql` call without a `spec` id is treated as exploration and does not trigger the automatic step-count pass.
- [ ] A `sql` call whose `spec` id is in the current frozen preface automatically triggers the per-step row-count pass when the query finishes, producing the step count files beside the run.
- [ ] A `sql` call whose `spec` id is not in the current frozen preface (or when no preface is frozen) still executes, still runs the step-count pass, and records on the run that the spec was not frozen.
- [ ] If the automatic step-count pass fails, the SQL run itself remains recorded with its result and the counts are left missing.

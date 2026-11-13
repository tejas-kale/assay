# 06: Per-row expansion, and quiet rows for Read, Grep, Glob and Bash

**What to build:** a long query gets a `[ full code ]` button and a result longer than 10 rows an `[ all rows ]`
button, each expanding that row alone; Read, Grep, Glob and Bash stay one line each and expand on demand. ctrl+o still
expands everything. Spec: `specs/rich-conversation.md`.

**Blocked by:** 03 (SQL rich row).

**Status:** implemented — automated checks passed; live Ghostty trial deferred

- [x] Expansion state is a `$.state` value keyed by tool use id, declared in the mod's type contract, and survives a reload.
- [x] Buttons appear only when there is more to show.
- [x] Mod tests press each button and check the expanded tree; quiet rows are covered for each of the four tools.

Mounted tests press full-code, all-rows and quiet-row details buttons, verify independent rows and remount persistence, and preserve ctrl+o. `expansion` is a declared `StateFamily` keyed by tool-use id; Claude Code owns hot-reload persistence. Code previews use 40 lines; full code is drawn in chunks within the element source limit.

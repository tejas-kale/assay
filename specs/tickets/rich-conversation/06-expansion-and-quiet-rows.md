# 06: Per-row expansion, and quiet rows for Read, Grep, Glob and Bash

**What to build:** a long query gets a `[ full code ]` button and a result longer than 10 rows an `[ all rows ]`
button, each expanding that row alone; Read, Grep, Glob and Bash stay one line each and expand on demand. ctrl+o still
expands everything. Spec: `specs/rich-conversation.md`.

**Blocked by:** 03 (SQL rich row).

**Status:** ready-for-agent

- [ ] Expansion state is a `$.state` value keyed by tool use id, declared in the mod's type contract, and survives a reload.
- [ ] Buttons appear only when there is more to show.
- [ ] Mod tests press each button and check the expanded tree; quiet rows are covered for each of the four tools.

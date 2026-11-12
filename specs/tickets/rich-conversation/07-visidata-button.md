# 07: `[ VisiData ]` copies the command for a run's table

**What to build:** a row with a table offers `[ VisiData ]`, which puts `vd '<absolute path of the run's csv>'` on the
clipboard and toasts that it did, so the user can paste it in a new Ghostty tab. Spec: `specs/rich-conversation.md`.

**Blocked by:** 03 (SQL rich row).

**Status:** ready-for-agent

- [ ] The path is quoted so that spaces survive the paste.
- [ ] A Python run with several tables offers one button per table.
- [ ] A failed copy (no clipboard) says so in the toast.
- [ ] Mod tests press the button and check the copied text.

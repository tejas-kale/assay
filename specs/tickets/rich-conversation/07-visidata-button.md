# 07: `[ VisiData ]` copies the command for a run's table

**What to build:** a row with a table offers `[ VisiData ]`, which puts `vd '<absolute path of the run's csv>'` on the
clipboard and toasts that it did, so the user can paste it in a new Ghostty tab. Spec: `specs/rich-conversation.md`.

**Blocked by:** 03 (SQL rich row).

**Status:** implemented — live Ghostty acceptance deferred by the user

- [x] The path is quoted so that spaces survive the paste.
- [x] A Python run with several tables offers one button per table.
- [x] A failed copy (no clipboard) says so in the toast.
- [x] Mod tests press the button and check the copied text.

The button copies on the surface that received the press. Before copying, the hook resolves the open analysis,
its real `queries/` directory and the table again, refusing a redirected table. Shell single quotes are escaped
inside the quoted absolute path. Native mounted tests cover spaces and an embedded quote, a refused clipboard,
Python tables in numeric K order, and a table redirected after rendering.

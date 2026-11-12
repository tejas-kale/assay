# 01: Spike in Ghostty and security review

**What to build:** a throwaway mod, loaded with Assay's plugin in a Claude Code session in Ghostty, that proves the
three things the design rests on, plus the security record for a mod that writes request files. Spec:
`specs/rich-conversation.md`.

**Blocked by:** None (can start immediately).

**Status:** partial — blocked on live Ghostty trial (see `specs/notes/rich-conversation-spike.md`)

- [ ] A `ToolUse` render hook on an `mcp__assay__sql` call sees the tool's stored result text, and the run number can be read from it.
- [ ] An `Image` draws a run's PNG plot in Ghostty; the fallback on a terminal without images is noted.
- [ ] `Code` highlighting for SQL, Python and a diff is readable under both Ayu themes (light and dark).
- [x] `docs/developer/security.md` records the mod as a request writer under PI-1, states that no tool of Claude's can raise its buttons, and confirms the hooks still stop Claude's file-edit tools writing into `.assay/`.
- [x] Findings that change the spec are written back into `specs/rich-conversation.md`; the spike's code is discarded.

The mounted contract test passed for supplied MCP result text on terminal and desktop, and the existing hook decision
suite passed (17/17). These do not complete the live-session result criterion. Ghostty is absent in this container;
image drawing and Ayu theme readability still require a real terminal trial. The throwaway mod is not shipped.

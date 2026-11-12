# 01: Spike in Ghostty and security review

**What to build:** a throwaway mod, loaded with Assay's plugin in a Claude Code session in Ghostty, that proves the
three things the design rests on, plus the security record for a mod that writes request files. Spec:
`specs/rich-conversation.md`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A `ToolUse` render hook on an `mcp__assay__sql` call sees the tool's stored result text, and the run number can be read from it.
- [ ] An `Image` draws a run's PNG plot in Ghostty; the fallback on a terminal without images is noted.
- [ ] `Code` highlighting for SQL, Python and a diff is readable under both Ayu themes (light and dark).
- [ ] `docs/developer/security.md` records the mod as a request writer under PI-1, states that no tool of Claude's can raise its buttons, and confirms the hooks still stop Claude writing into `.assay/`.
- [ ] Findings that change the spec are written back into `specs/rich-conversation.md`; the spike's code is discarded.

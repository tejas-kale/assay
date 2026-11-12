# 02: `assay open` starts an analysis's Claude session in any terminal

**What to build:** `assay open <slug>` in Ghostty starts Claude for that analysis with the same plugin, MCP server,
environment and launcher the app would use; `assay open` with no slug lists the analyses. Spec:
`specs/rich-conversation.md`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The launch is built by the same spawn-spec function the app uses, so the variables, `--plugin-dir` and `--mcp-config` match the launch contract.
- [ ] `ASSAY_CLAUDE_BIN` is honoured when set (the Podman wrapper runs), and plain `claude` runs otherwise.
- [ ] An unknown slug fails and lists the known analyses; a missing root, backend or venv fails with a named reason.
- [ ] `npm run install-app` puts `assay` on PATH.
- [ ] The resolving and launch-building logic is pure, in the core, tested with node:test, and meets the coverage bar.
- [ ] In the trial session, the `sql` tool runs and its run appears in `queries/` and in the app's History.

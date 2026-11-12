# 02: `assay open` starts an analysis's Claude session in any terminal

**What to build:** `assay open <slug>` in Ghostty starts Claude for that analysis with the same plugin, MCP server,
environment and launcher the app would use; `assay open` with no slug lists the analyses. Spec:
`specs/rich-conversation.md`.

**Blocked by:** None (can start immediately).

**Status:** code implemented — installed-app trial pending

- [x] The launch is built by the same spawn-spec function the app uses, so the variables, `--plugin-dir` and `--mcp-config` match the launch contract.
- [x] `ASSAY_CLAUDE_BIN` is honoured when set (the Podman wrapper runs), and plain `claude` runs otherwise.
- [x] An unknown slug fails and lists the known analyses; a missing root, backend or venv fails with a named reason.
- [x] `npm run install-app` puts `assay` on PATH.
- [x] The resolving and launch-building logic is pure, in the core, tested with node:test, and meets the coverage bar.
- [ ] In the trial session, the `sql` tool runs and its run appears in `queries/` and in the app's History.

The CLI is bundled at `backend/out/cli/assay.mjs`, installed by `npm run install-app`, and uses the app’s
`spawnSpec`. Node 22.15 or later is required for replacing the current process. The installed-app SQL/History
trial has not been run in this container.

Review added an exclusive server session claim so terminal and app sessions cannot start competing kernels for
one analysis. Scratch bundled-CLI tests exercise the launcher environment, listing and preparation failures;
server lifecycle tests cover conflicting sessions, failed startup and claim ownership. These are automated checks,
not the installed-app trial. Close older app sessions before that trial.

Accepted trial tradeoff: SIGKILL or a crash leaves a stale server claim. This also blocks reopening in the app,
whose unchanged UI reports a generic MCP connection failure. Follow the launch contract's manual recovery only
after all sessions for the analysis have stopped; automatic cross-namespace liveness recovery is out of scope.

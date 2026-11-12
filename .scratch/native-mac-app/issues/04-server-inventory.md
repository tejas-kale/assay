# What the TypeScript server, hooks and shared core do, and what moves to Python

Type: research
Status: resolved

## Question

Inventory Assay's src/server, src/hooks, src/shared and the 13 src/core modules that both the server and the app import. Do not touch the 44 core modules only the app uses: the map's fog keeps those for the architecture decision.

For each module, record:
- what it does
- which files of the file protocol it reads or writes
- whether the Python kernel already holds similar logic
- what the Swift app would need to read

Also list the server's MCP tools and the hooks' behaviour, which the Python server and hooks must match. The source is this repository.

## Answer

Findings: [research/04-server-inventory.md](../research/04-server-inventory.md).

- **Most of the logic is already Python.** The server already calls `analysis_sql` and `analysis_trust` for the SQL rules, lineage, step plans and trust checks. The TypeScript is mostly orchestration: numbering runs, queues, the request poller, supervising the kernel, the Databricks and psql calls, promoting trusted calculations through git, the note and thread tools, and the hooks.
- **The rules shared with the app don't vanish when Node goes; they move.** They cover run file names and headers, `threads.md`, root notes and citation labels. With a Swift app they would exist in both Python and Swift, unless Python serves the app parsed views, or both test suites share the same fixtures.
- **The launch contract has to change.** The server command (exactly `node …/index.mjs`) and `hooks.json`'s `node` calls become the venv's Python, and the Podman wrapper must change at the same time. The venv is built in the background, so the server and hooks may start before it is ready.
- **Open:** `mcp` is not yet in `pyproject.toml`; Python's start-up time for the hook that fires on every tool call is unmeasured; the Python SDK's shutdown behaviour is unchecked.

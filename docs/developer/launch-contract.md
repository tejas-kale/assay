# The launch contract

This is the only description a launcher needs: what the app runs to start Claude, and what a launcher that runs
Claude somewhere else (a container, a VM) must provide. The user's Podman wrapper in the config repo is one such
launcher. Assay itself works with plain Claude Code.

## What the app runs

For each open analysis, the app runs, through the user's login, interactive shell (`$SHELL -lic`, so `claude` is
found as a terminal finds it), in the root folder:

```sh
exec "${ASSAY_CLAUDE_BIN:-claude}" --mcp-config "$ASSAY_MCP_CONFIG" --plugin-dir "$ASSAY_BACKEND/plugin"
```

`ASSAY_CLAUDE_BIN` is the launcher; unset, plain `claude` runs. The plugin (hooks and skills) loads with
`--plugin-dir` and the server with `--mcp-config` on each launch, so only sessions Assay starts see them. The environment carries the app's own, plus:

| Variable | Value |
|---|---|
| `ASSAY_APP` | `1` |
| `ASSAY_ROOT` | the Settings folder (holds `analyses/`, `dictionaries/`, `trusted/`) |
| `ASSAY_ANALYSIS` | the open analysis's folder |
| `ASSAY_BACKEND` | `~/Library/Application Support/Assay/backend/<version>` |
| `ASSAY_MCP_CONFIG` | the server `assay`, as JSON: `{"mcpServers":{"assay":{"command":"node","args":["<ASSAY_BACKEND>/plugin/../out/server/index.mjs"]}}}` |
| `ASSAY_VENV` | `~/Library/Application Support/Assay/venvs/<version>` |
| `ASSAY_LEDGER` | `~/Library/Application Support/Assay/trust-ledger/<sha256 of the root's real path>.json`: the root's trust ledger, written by the app only (specs/trust-ledger.md); the file may not exist yet |
| `ASSAY_THEME` | Claude Code's theme: `dark-ansi` or `light-ansi` |

Every path is absolute. `ASSAY_BACKEND` and `ASSAY_VENV` contain a space (`Application Support`): quote them.

`ASSAY_BACKEND` holds the plugin (`plugin/`), the bundled MCP server and hooks (`out/server/`, `out/hooks/`) and the
Python project (`python/`, with `uv.lock`). The app builds `ASSAY_VENV` from it with uv, in the background: until it
is ready, Python tools answer that it is still building, and `ASSAY_VENV.status.json` (beside the venv) says
`building`, `ready` or `failed` with the error. Without `ASSAY_VENV`, every tool answers that Assay did not start the
session.

## The server `assay`

The app declares the MCP server itself, with `--mcp-config`, so Claude names it `assay` and its tools
`mcp__assay__<tool>`. A server that a plugin declares is always named `plugin:<plugin>:<server>`, so the plugin
declares none. Two constraints hold for every launcher:

- The command is exactly `node` with one argument, `$ASSAY_BACKEND/plugin/../out/server/index.mjs`, `plugin/..`
  included and unresolved. A launcher may allowlist the server by this exact command.
- The app does not pass `--strict-mcp-config`, so a launcher may add its own MCP servers.

## What a launcher that runs Claude elsewhere must do

- Mount `ASSAY_LEDGER`'s folder (`trust-ledger/`) read-only, like `ASSAY_BACKEND`, at the same absolute path: Claude must never write it.
- Make `ASSAY_ROOT`, `ASSAY_ANALYSIS` and `ASSAY_BACKEND` valid at the **same absolute paths**, with `ASSAY_BACKEND`
  read-only.
- Provide `node` 22 or later and `databricks` on Claude's PATH, plus `rds-psql` if Postgres runs are wanted. Without
  `rds-psql`, a Postgres run fails with a message that points here.
- Replace `ASSAY_VENV` with a venv valid where Claude runs, built from `$ASSAY_BACKEND/python` with
  `uv sync --frozen --no-editable --no-dev` (the Mac's venv holds macOS binaries). Build it per Assay version: the project
  installs into it non-editable, so each version's venv holds that version's helpers. A launcher's venv needs no
  status file; it counts as built when its `bin/python` exists.
- Pass `ASSAY_APP`, `ASSAY_ROOT`, `ASSAY_ANALYSIS`, `ASSAY_MCP_CONFIG` and `ASSAY_THEME` through unchanged, and
  `--mcp-config` with the rest of Claude's arguments.

## Isolation is the launcher's job

Assay enforces its own rules: its hooks (no Python through Bash, nothing written into `trusted/`, `dictionaries/`,
`.git`, the runs, the app's requests or another analysis), its tools, its IPC and its updater. It does not contain what
code can do once it runs. Containing code execution belongs to the launcher: the Podman wrapper, or Claude Code's own
sandbox. docs/developer/security.md draws this boundary in full.

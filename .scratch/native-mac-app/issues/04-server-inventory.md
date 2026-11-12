# What the TypeScript server, hooks and shared core do, and what moves to Python

Type: research
Status: open

## Question

Inventory Assay's src/server, src/hooks, src/shared and the 13 src/core modules that both the server and the app import. Do not touch the 44 core modules only the app uses: the map's fog keeps those for the architecture decision.

For each module, record:
- what it does
- which files of the file protocol it reads or writes
- whether the Python kernel already holds similar logic
- what the Swift app would need to read

Also list the server's MCP tools and the hooks' behaviour, which the Python server and hooks must match. The source is this repository.

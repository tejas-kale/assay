# Verify uv-managed Python runs from a notarised app on a clean Mac

Type: task
Status: open
Blocked by: 01, 06

## Question

HITL. Build a minimal signed and notarised app that ships uv, installs a pinned managed Python into Application Support, builds a venv with polars and duckdb, and runs it. Do this on a Mac (or a fresh user account) without developer tools. Record what happened, including any quarantine or library-validation errors.

Check specifically, from the distribution research:
- whether `install_name_tool` prompts for the Command Line Tools
- uv #16726 (Python killed until re-signed ad hoc)
- uv #17371 (a slow first run on Tahoe)
- whether signing the Python tree ad hoc after installing it is needed

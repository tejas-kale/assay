# Verify uv-managed Python runs from a notarised app on a clean Mac

Type: task
Status: open
Blocked by: 01, 06

## Question

HITL. Build a minimal signed and notarised app that ships uv, installs a pinned managed Python into Application Support, builds a venv with polars and duckdb, and runs it. Do this on a Mac (or a fresh user account) without developer tools. Record what happened, including any quarantine or library-validation errors.

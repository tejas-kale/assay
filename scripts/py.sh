#!/bin/sh
# Runs a command in the check's Python environment: python/'s project with its dev group (ruff, pytest-cov), synced
# from uv.lock into the root .venv. The root, not python/.venv: in the sandbox the root .venv is the container's own
# volume, so a Linux venv never lands in the Mac's checkout.
root=$(cd "$(dirname "$0")/.." && pwd)
UV_PROJECT_ENVIRONMENT="$root/.venv" exec uv run --quiet --frozen --project "$root/python" "$@"

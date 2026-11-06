#!/usr/bin/env bash
# Builds pyproject.toml with uv in a scratch copy and checks the venv: analysis_db imports from another folder,
# `python -m analysis_trust` runs there (sqlglot, pyyaml, duckdb and duckdb-engine are in), and the
# databricks-sqlalchemy dialect and ipykernel are there. Needs uv and PyPI (claude-pkg's registry port in the sandbox). Usage: tests/test_venv.sh [scratch-dir]
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=${1:-$(mktemp -d)}
mkdir -p "$work/src" "$work/elsewhere"
cp "$here/pyproject.toml" "$here/analysis_db.py" "$here/analysis_trust.py" "$here/analysis_sql.py" "$work/src/"
(cd "$work/src" && uv sync --quiet)
py=$work/src/.venv/bin/python
(cd "$work/elsewhere" && "$py" -c 'import analysis_db, databricks.sqlalchemy, databricks.sql, ipykernel, sqlalchemy; print("import ok", sqlalchemy.__version__)')
(cd "$work/elsewhere" && "$py" -c 'import duckdb_engine, sqlglot, yaml' && "$py" -m analysis_trust list "$work/elsewhere" | grep -q '"calculations": \[\]' \
  && echo 'SELECT 1' | "$py" -m analysis_sql lint databricks | grep -q '"errors": \[\]') \
  || { echo "FAIL: python -m analysis_trust does not run from another folder" >&2; exit 1; }
echo "analysis_trust ok"

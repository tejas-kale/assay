"""Fixture tests: ``<name>.test.yaml`` beside a calculation or a dictionary entry, run on DuckDB.

The file holds ``tables`` (CSV text by table name), ``cases`` (``args``, ``expect`` as CSV, ``ordered``; for an entry,
the ``definition`` each case runs) and ``live`` (the arguments of the live check).
"""

from __future__ import annotations

import csv
import difflib
import io
import tempfile
from pathlib import Path
from typing import Any

import duckdb
import sqlglot
import yaml
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlglot import exp

from analysis_calc import DIALECT, TrustError, comparable, convert, describe, frame_table, python_function
from analysis_dictionary import definition_parameters, definitions_of, is_full_name, read_entry, render_definition

# Database names DuckDB keeps for itself; a fixture catalog of that name is attached with a _ after it,
# and SQL templates are rewritten to match (Unity Catalog's default catalog is often `main`).
RESERVED_CATALOGS = {"main", "system", "temp", "memory"}
DIFF_LINES = 40


def load_tests(folder: Path, name: str) -> dict[str, Any]:
    """``<name>.test.yaml`` in ``folder``, or an empty one."""
    path = folder / f"{name}.test.yaml"
    data = yaml.safe_load(path.read_text()) if path.is_file() else {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# Fixture tables on DuckDB.


def csv_relation(text: str) -> str:
    """A temporary CSV file holding ``text``, as a DuckDB read_csv call."""
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as handle:
        handle.write(text if text.endswith("\n") else f"{text}\n")
    return f"read_csv('{handle.name}', header = true)"


def fixture_catalog(name: str) -> str:
    """The DuckDB database a fixture table's catalog becomes."""
    return f"{name}_" if name.lower() in RESERVED_CATALOGS else name


def create_tables(connection: Any, tables: dict[str, str]) -> None:
    """Creates each fixture table on a DuckDB connection: a three-part name gets its catalog attached."""
    attached = {row[0] for row in connection.execute("SELECT database_name FROM duckdb_databases()").fetchall()}
    for full, text in (tables or {}).items():
        parts = str(full).lower().split(".")
        if is_full_name(str(full)):
            parts[0] = fixture_catalog(parts[0])
            if parts[0] not in attached:
                connection.execute(f"ATTACH ':memory:' AS \"{parts[0]}\"")
                attached.add(parts[0])
        quoted = ".".join(f'"{part}"' for part in parts)
        if len(parts) > 1:
            connection.execute(f"CREATE SCHEMA IF NOT EXISTS {quoted.rsplit('.', 1)[0]}")
        connection.execute(f"CREATE TABLE {quoted} AS SELECT * FROM {csv_relation(str(text))}")


def fixture_engine(tables: dict[str, str]) -> Engine:
    """A SQLAlchemy engine on an in-memory DuckDB holding ``tables``: for a Python calculation's own tests."""
    engine = create_engine("duckdb:///:memory:", poolclass=StaticPool)
    raw = engine.raw_connection()
    create_tables(raw.driver_connection, tables)
    raw.close()
    return engine


def to_duckdb(sql: str) -> str:
    """A Databricks statement as DuckDB SQL for the fixtures; a TrustError when sqlglot cannot transpile it.

    ``:name`` becomes ``$name``, and a catalog DuckDB reserves is renamed as ``fixture_catalog`` does.
    """
    try:
        statements = [statement for statement in sqlglot.parse(sql, read=DIALECT) if statement is not None]
    except Exception as error:
        raise TrustError(f"does not transpile to DuckDB: {error}") from None
    if len(statements) != 1:
        raise TrustError(f"is {len(statements)} statements, not one")
    statement = statements[0]
    for table in statement.find_all(exp.Table):
        if table.catalog:
            table.set("catalog", exp.to_identifier(fixture_catalog(table.catalog.lower())))
    try:
        return statement.sql(dialect="duckdb", unsupported_level=sqlglot.ErrorLevel.RAISE)
    except Exception as error:
        raise TrustError(f"does not transpile to DuckDB: {error}") from None


def rows_of(
    connection: Any, sql: str, params: dict[str, Any] | None = None
) -> tuple[list[str], list[tuple[Any, ...]]]:
    result = connection.execute(sql, params or {})
    return [d[0] for d in result.description], [tuple(comparable(v) for v in row) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Comparing a result with a case's expected CSV.


class MismatchError(AssertionError):
    """A fixture case's result differs from its expected CSV; ``diff`` shows both as CSV lines."""

    def __init__(self, message: str, diff: str) -> None:
        super().__init__(message)
        self.diff = diff


def csv_lines(columns: list[str], rows: list[tuple[Any, ...]]) -> list[str]:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow(["" if value is None else value for value in row])
    return out.getvalue().splitlines()


def line_diff(expected: list[str], got: list[str], limit: int = DIFF_LINES) -> str:
    """``expected`` against ``got``: ``  `` same, ``- `` expected only, ``+ `` got only.

    At most ``limit`` lines, then a count of the rest.
    """
    lines: list[str] = []
    for tag, a0, a1, b0, b1 in difflib.SequenceMatcher(None, expected, got, autojunk=False).get_opcodes():
        if tag == "equal":
            lines += [f"  {line}" for line in expected[a0:a1]]
        else:
            lines += [f"- {line}" for line in expected[a0:a1]] + [f"+ {line}" for line in got[b0:b1]]
    if len(lines) > limit:
        return "\n".join([*lines[:limit], f"… {len(lines) - limit} more"])
    return "\n".join(lines)


def _row_order(row: tuple[Any, ...]) -> tuple[tuple[bool, str], ...]:
    return tuple((v is None, repr(v)) for v in row)


def compare(columns: list[str], rows: list[tuple[Any, ...]], expected: str, *, ordered: bool) -> None:
    """Asserts a result equals the expected CSV: same columns, same rows (in order when ``ordered``)."""
    want_columns, want_rows = rows_of(duckdb.connect(), f"SELECT * FROM {csv_relation(expected)}")
    got, want = (rows, want_rows) if ordered else (sorted(rows, key=_row_order), sorted(want_rows, key=_row_order))
    if columns != want_columns:
        message = f"columns {columns} != expected {want_columns}"
    elif got != want:
        message = f"rows {got} != expected {want}"
    else:
        return
    raise MismatchError(message, line_diff(csv_lines(want_columns, want), csv_lines(columns, got)))


# ---------------------------------------------------------------------------
# Running one case.


def run_case(folder: Path, name: str, index: int) -> None:
    """Runs case ``index`` of a calculation's fixture tests on DuckDB; a failed comparison raises."""
    tests = load_tests(folder, name)
    case = (tests.get("cases") or [])[index]
    tables = tests.get("tables") or {}
    if is_full_name(name) and (folder / f"{name}.yaml").is_file():
        columns, rows = _definition_case(folder, name, case, tables)
    else:
        columns, rows = _calculation_case(folder, name, case, tables)
    compare(columns, rows, str(case.get("expect", "")), ordered=bool(case.get("ordered")))


def _definition_case(
    folder: Path, name: str, case: dict[str, Any], tables: dict[str, str]
) -> tuple[list[str], list[tuple[Any, ...]]]:
    """A dictionary entry's case: it runs one of the entry's definitions."""
    data = read_entry(folder / f"{name}.yaml")
    definition = str(case.get("definition") or "")
    kind = next((item["kind"] for item in definitions_of(data) if item["name"] == definition), "metric")
    values = convert(definition_parameters(kind), case.get("args") or {})
    connection = duckdb.connect()
    create_tables(connection, tables)
    return rows_of(connection, to_duckdb(render_definition(data, name, definition, values)))


def _calculation_case(
    folder: Path, name: str, case: dict[str, Any], tables: dict[str, str]
) -> tuple[list[str], list[tuple[Any, ...]]]:
    found = describe(folder, name)
    values = convert(found["parameters"], case.get("args") or {})
    if found["kind"] == "sql":
        connection = duckdb.connect()
        create_tables(connection, tables)
        return rows_of(connection, to_duckdb(found["sql"]), values)
    function, _, _ = python_function(folder / found["file"])
    table = frame_table(function(fixture_engine(tables), **values))
    return table["columns"], [tuple(comparable(parse_cell(v)) for v in row) for row in table["rows"]]


def parse_cell(text: str) -> Any:
    """A CSV cell back as a number when it reads as one, so a frame compares like a query."""
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return text

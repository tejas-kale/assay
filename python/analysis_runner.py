"""Running a trusted calculation or definition on the analysis's warehouse (``analysis_db.engine``)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import text

import analysis_db
import analysis_sql
from analysis_calc import (
    DIALECT,
    Source,
    TrustError,
    cell,
    comparable,
    convert,
    describe,
    frame_table,
    python_function,
    read_calculation,
)
from analysis_dictionary import DICTIONARIES, describe_definition, read_definition_source, render_definition
from analysis_imports import trusted_imports


def expand_template(sql: str, root: Path, name: str) -> str:
    """A template with the definitions it includes expanded (specs/slices/slice-10.md); a TrustError when it includes a
    block, or a piece that is unknown or not approved in the app."""
    if "{{" not in sql:
        return sql
    found = analysis_sql.expand(sql, DIALECT, root, inside_block=name)
    if found.get("errors"):
        raise TrustError(" ".join(found["errors"]))
    return found["sql"]


def render(notes_src: Path, name: str, given: dict[str, Any], source: Source | None = None) -> str:
    """The SQL a definition's run sends, its arguments checked; from ``source``'s bytes when given."""
    found = describe_definition(notes_src / DICTIONARIES, name, source)
    table, _, definition = name.partition(":")
    return render_definition(found["entry"], table, definition, convert(found["parameters"], given))


def run_live_sql(sql: str, analysis: Path) -> dict[str, Any]:
    """Runs SQL that has no parameters (a definition's query) on the analysis's warehouse."""
    with analysis_db.engine(start=analysis).connect() as connection:
        result = connection.exec_driver_sql(sql)
        return {"columns": list(result.keys()), "rows": [[cell(v) for v in row] for row in result]}


def run_rows(sql: str, values: dict[str, Any], analysis: Path) -> tuple[list[str], list[tuple[Any, ...]]]:
    """A template's columns and rows, values comparable, on the analysis's warehouse."""
    with analysis_db.engine(start=analysis).connect() as connection:
        result = connection.execute(text(sql), values)
        return list(map(str, result.keys())), [tuple(comparable(v) for v in row) for row in result]


def run(folder: Path, name: str, given: dict[str, Any], analysis: Path) -> dict[str, Any]:
    """Runs a calculation in ``folder`` on the analysis's warehouse; its result as ``{columns, rows}``.

    A ``<table>:<name>`` is a definition, read from ``dictionaries/`` beside ``folder``.
    """
    if ":" in name:
        source = read_definition_source(folder.parent / DICTIONARIES, name)
    else:
        source = read_calculation(folder, name)
    return run_checked(folder, source, given, analysis)


def run_checked(folder: Path, source: Source, given: dict[str, Any], analysis: Path) -> dict[str, Any]:
    """``run`` of the file ``source`` holds, which is used as it is and never read again: the caller has verified it."""
    name = source.name
    if ":" in name:
        return run_live_sql(render(folder.parent, name, given, source), analysis)
    found = describe(folder, name, source)
    values = convert(found["parameters"], given)
    if found["kind"] == "python":
        function, _, _ = python_function(folder / found["file"], source)
        with trusted_imports(folder):
            return frame_table(function(analysis_db.engine(start=analysis), **values))
    return run_table(expand_template(found["sql"], folder.parent, name), values, analysis)


def run_table(sql: str, values: dict[str, Any], analysis: Path) -> dict[str, Any]:
    """Runs expanded template SQL on the analysis's warehouse; its result as ``{columns, rows}``."""
    with analysis_db.engine(start=analysis).connect() as connection:
        result = connection.execute(text(sql), values)
        return {"columns": list(result.keys()), "rows": [[cell(v) for v in row] for row in result]}

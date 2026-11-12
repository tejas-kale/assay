"""Running a trusted calculation or definition on the analysis's warehouse (``analysis_db.engine``)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import text

import analysis_db
import analysis_sql
from analysis_calc import DIALECT, TrustError, cell, comparable, convert, describe, frame_table, python_function
from analysis_dictionary import DICTIONARIES, describe_definition, render_definition


def expand_template(sql: str, root: Path, name: str) -> str:
    """A template with the definitions it includes expanded (docs/slice-10.md); a TrustError when it includes a block,
    or a piece that is unknown or not trusted as committed."""
    if "{{" not in sql:
        return sql
    found = analysis_sql.expand(sql, DIALECT, root, inside_block=name)
    if found.get("errors"):
        raise TrustError(" ".join(found["errors"]))
    return found["sql"]


def render(notes_src: Path, name: str, given: dict[str, Any]) -> str:
    """The SQL a definition's run sends, its arguments checked."""
    found = describe_definition(notes_src / DICTIONARIES, name)
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
        return run_live_sql(render(folder.parent, name, given), analysis)
    found = describe(folder, name)
    values = convert(found["parameters"], given)
    if found["kind"] == "python":
        function, _, _ = python_function(folder / found["file"])
        return frame_table(function(analysis_db.engine(start=analysis), **values))
    return run_table(expand_template(found["sql"], folder.parent, name), values, analysis)


def run_table(sql: str, values: dict[str, Any], analysis: Path) -> dict[str, Any]:
    """Runs expanded template SQL on the analysis's warehouse; its result as ``{columns, rows}``."""
    with analysis_db.engine(start=analysis).connect() as connection:
        result = connection.execute(text(sql), values)
        return {"columns": list(result.keys()), "rows": [[cell(v) for v in row] for row in result]}

"""What a trusted calculation is: its form, its parameters and the values it takes and returns.

A calculation is ``<name>.sql`` (a SQL template: front matter, then one Databricks statement) or ``<name>.py`` (a
function named after the file, taking a SQLAlchemy engine). The other ``analysis_*`` trust modules build on this one;
it imports none of them, nor the SQL modules, so ``analysis_include`` can import it.
"""

from __future__ import annotations

import datetime
import importlib.util
import inspect
import re
from decimal import Decimal
from pathlib import Path
from typing import Any

import sqlglot
import yaml
from sqlglot import exp

DIALECT = "databricks"
NAME = re.compile(r"^[a-z][a-z0-9_]*$")
FRONT = re.compile(r"\A\s*/\*---\s*\n(.*?)\n---\*/[ \t]*\n?", re.DOTALL)
TYPES = ("string", "integer", "number", "boolean", "date")
PY_TYPES = {
    "str": "string",
    "int": "integer",
    "float": "number",
    "bool": "boolean",
    "date": "date",
    "datetime.date": "date",
}
# Digits a number keeps when results are compared, so 0.1 + 0.2 equals 0.3.
COMPARED_DIGITS = 9


class TrustError(Exception):
    """What makes a calculation unusable, said for the person."""


def plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def cell(value: Any) -> str:
    """A result value as a run's CSV holds it."""
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def comparable(value: Any) -> Any:
    """A result value as two results are compared: numbers as rounded floats, the rest as their cell."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return round(float(value), COMPARED_DIGITS)
    return cell(value)


def frame_table(frame: Any) -> dict[str, Any]:
    """A pandas or polars data frame as ``{columns, rows}`` of strings."""
    if hasattr(frame, "iter_rows"):  # polars
        rows = frame.iter_rows()
    elif hasattr(frame, "itertuples"):  # pandas
        rows = frame.itertuples(index=False)
    else:
        raise TrustError(f"the function returned a {type(frame).__name__}, not a data frame")
    return {"columns": [str(c) for c in frame.columns], "rows": [[cell(v) for v in row] for row in rows]}


# ---------------------------------------------------------------------------
# SQL templates.


def split_template(text: str) -> tuple[dict[str, Any], str]:
    """A SQL template's front matter (the ``/*--- ... ---*/`` block at its top) and its SQL."""
    match = FRONT.match(text)
    if not match:
        raise TrustError(
            "no front matter: start the file with a /*--- ... ---*/ block holding description and parameters"
        )
    front = yaml.safe_load(match.group(1)) or {}
    if not isinstance(front, dict):
        raise TrustError("the front matter is not a mapping")
    return front, text[match.end() :].strip()


def parameters_of(declared: Any) -> list[dict[str, Any]]:
    """Declared parameters as a list of ``{name, type, required}``: from ``name: type`` or ``name: {type, default}``."""
    found = []
    for name, spec in (declared or {}).items():
        kind, has_default = (spec.get("type"), "default" in spec) if isinstance(spec, dict) else (spec, False)
        if kind not in TYPES:
            raise TrustError(f"parameter {name}: type {kind!r} is not one of {', '.join(TYPES)}")
        found.append({"name": str(name), "type": kind, "required": not has_default})
    return found


def placeholders(sql: str) -> set[str]:
    """The ``:name`` parameters a Databricks statement uses, from sqlglot's parse."""
    statements = [statement for statement in sqlglot.parse(sql, read=DIALECT) if statement]
    return {str(node.name) for statement in statements for node in statement.find_all(exp.Placeholder)}


def block_contract(front: dict[str, Any]) -> dict[str, Any] | None:
    """The ``block:`` contract of a template's front matter, checked; None when the template is not a block.

    A block (docs/slice-10.md, slice 10b) joins tables at a fixed grain. ``grain`` is a list of column names (``[]``
    for one row); ``columns`` maps each output column, in order, to what it means.
    """
    if "block" not in front:
        return None
    block = front["block"]
    if not isinstance(block, dict):
        raise TrustError("block: is a mapping with grain and columns")
    columns = _contract_columns(block.get("columns"))
    grain = _contract_grain(block.get("grain"), columns)
    return {"grain": grain, "columns": columns}


def _contract_columns(columns: Any) -> dict[str, str]:
    if not isinstance(columns, dict) or not columns:
        raise TrustError("block: columns maps each output column to what it means")
    for column, meaning in columns.items():
        if not str(meaning or "").strip():
            raise TrustError(f"block: column {column} says nothing about what it means")
    return {str(k): str(v).strip() for k, v in columns.items()}


def _contract_grain(grain: Any, columns: dict[str, str]) -> list[str]:
    if grain == "none":
        grain = []
    if not isinstance(grain, list) or not all(isinstance(each, str) for each in grain):
        raise TrustError("block: grain is a list of columns, [] for one row")
    names = {name.lower() for name in columns}
    missing = [column for column in grain if column.lower() not in names]
    if missing:
        raise TrustError(f"block: grain column {', '.join(missing)} is not one of its columns")
    return grain


# ---------------------------------------------------------------------------
# Python functions.


def load_module(path: Path) -> Any:
    """The Python file at ``path`` as a module, imported afresh."""
    spec = importlib.util.spec_from_file_location(f"trusted_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise TrustError(f"cannot import {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def python_function(path: Path) -> tuple[Any, str, list[dict[str, Any]]]:
    """The function named after the file, its docstring and its parameters after the engine."""
    function = getattr(load_module(path), path.stem, None)
    if not callable(function):
        raise TrustError(f"{path.name} has no function {path.stem}")
    doc = inspect.getdoc(function)
    if not doc:
        raise TrustError(f"{path.stem} has no docstring")
    params = list(inspect.signature(function).parameters.values())
    if not params:
        raise TrustError(f"{path.stem} takes no engine: its first parameter must be the SQLAlchemy engine")
    return function, doc, [_python_parameter(param) for param in params[1:]]


def _python_parameter(param: inspect.Parameter) -> dict[str, Any]:
    annotation = param.annotation
    written = annotation if isinstance(annotation, str) else getattr(annotation, "__name__", "")
    kind = PY_TYPES.get(str(written))
    if kind is None:
        raise TrustError(f"parameter {param.name}: annotate it with str, int, float, bool or date")
    return {"name": param.name, "type": kind, "required": param.default is inspect.Parameter.empty}


# ---------------------------------------------------------------------------
# Either kind.


def describe(folder: Path, name: str) -> dict[str, Any]:
    """A calculation in ``folder``: its kind, file, one-line description and parameters (and SQL, for a template)."""
    sql, py = folder / f"{name}.sql", folder / f"{name}.py"
    if sql.is_file() == py.is_file():
        raise TrustError(f"{name}: need exactly one of {name}.sql and {name}.py in {folder}")
    if sql.is_file():
        return _describe_template(sql, name)
    _, doc, params = python_function(py)
    return {"name": name, "kind": "python", "file": py.name, "description": doc.splitlines()[0], "parameters": params}


def _describe_template(path: Path, name: str) -> dict[str, Any]:
    front, body = split_template(path.read_text())
    description = str(front.get("description") or "").strip()
    if not description:
        raise TrustError(f"{name}.sql: the front matter has no description")
    found = {
        "name": name,
        "kind": "sql",
        "file": path.name,
        "description": description.splitlines()[0],
        "parameters": parameters_of(front.get("parameters")),
        "sql": body,
    }
    contract = block_contract(front)
    if contract is not None:
        found["block"] = {"grain": contract["grain"], "columns": list(contract["columns"])}
    return found


FITS = {
    "string": lambda value: isinstance(value, str),
    "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
    "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool),
    "boolean": lambda value: isinstance(value, bool),
    "date": lambda value: isinstance(value, (str, datetime.date)),
    "list": lambda value: isinstance(value, list) and all(isinstance(each, str) for each in value),
}


def convert(params: list[dict[str, Any]], given: dict[str, Any]) -> dict[str, Any]:
    """The arguments as Python values of their declared types; an unknown, missing or ill-typed one is a TrustError."""
    known = {param["name"]: param for param in params}
    unknown = sorted(set(given) - set(known))
    if unknown:
        raise TrustError(f"unknown arguments: {', '.join(unknown)}")
    values: dict[str, Any] = {}
    for name, param in known.items():
        if name in given:
            values[name] = _converted(name, param["type"], given[name])
        elif param["required"]:
            raise TrustError(f"missing argument: {name}")
    return values


def _converted(name: str, kind: str, value: Any) -> Any:
    if not FITS[kind](value):
        raise TrustError(f"argument {name} must be a {'list of names' if kind == 'list' else kind}")
    if kind != "date" or not isinstance(value, str):
        return value
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        raise TrustError(f"argument {name} must be a date as YYYY-MM-DD") from None

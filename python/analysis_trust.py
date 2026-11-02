"""Assay's Python side of the data dictionary and trusted calculations.

Assay's MCP server (``src/server``) runs it with venv-assay's python as ``python -m analysis_trust
<command> ...``; each command prints one JSON object on stdout. It parses SQL with sqlglot, reads the
YAML files in ``<notes-src>/dictionaries/`` and, for trusted calculations, ``<notes-src>/trusted/``.

    dictionary <notes-src> <sql-file>          the tables the SQL touches and their dictionary entries
    list <notes-src>                           the trusted calculations, with their commits
    run <notes-src> <name> <args> <analysis>   runs one on the analysis's warehouse
    render <notes-src> <table:definition> <args>  the SQL a definition's run sends
    check <folder> <name> <analysis> [--stream]    what the Trust tab shows: form, transpile, tests, a live run
    check-entry <draft-file> <analysis> [--stream] what the Trust tab shows for a drafted dictionary entry

With ``--stream`` a check prints one JSON line per event (start, step, done) as it happens.

It lives in the Assay repo (``python/``). Layout and formats: the Assay README.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import sqlglot
import yaml
from sqlglot import exp

DIALECT = "databricks"
DICTIONARIES = "dictionaries"
GLOSSARY = "glossary.yaml"


# ---------------------------------------------------------------------------
# Tables a statement touches.


def table_names(sql: str, dialect: str = DIALECT) -> list[str]:
    """The tables ``sql`` reads, as written (``catalog.schema.table``, ``schema.table`` or ``table``), sorted.

    CTE names are left out; so are table functions. Names are lower-cased: Unity Catalog names are
    case-insensitive.
    """
    found: list[str] = []
    for statement in sqlglot.parse(sql, read=dialect):
        if statement is None:
            continue
        ctes = {cte.alias_or_name.lower() for cte in statement.find_all(exp.CTE)}
        for table in statement.find_all(exp.Table):
            if not table.name or isinstance(table.this, exp.Func):
                continue
            parts = [part for part in (table.catalog, table.db, table.name) if part]
            if len(parts) == 1 and parts[0].lower() in ctes:
                continue
            name = ".".join(parts).lower()
            if name not in found:
                found.append(name)
    return sorted(found)


# ---------------------------------------------------------------------------
# The data dictionary: <notes-src>/dictionaries/<catalog>.<schema>.<table>.yaml and glossary.yaml.


def dictionary_files(notes_src: Path) -> dict[str, Path]:
    """Each table's entry by its full name, lower-cased; the glossary and test files are not entries."""
    folder = notes_src / DICTIONARIES
    if not folder.is_dir():
        return {}
    entries = {}
    for path in folder.glob("*.yaml"):
        name = path.name[: -len(".yaml")].lower()
        if path.name == GLOSSARY or name.endswith(".test") or name.count(".") != 2:
            continue
        entries[name] = path
    return entries


def resolve(name: str, entries: dict[str, Path]) -> str | None:
    """The full name of the entry ``name`` stands for: itself, or the one entry ending in it."""
    if name in entries:
        return name
    if name.count(".") == 2:
        return None
    matches = [full for full in entries if full.endswith(f".{name}")]
    return matches[0] if len(matches) == 1 else None


def read_glossary(notes_src: Path) -> dict[str, str]:
    """``terms:`` in glossary.yaml: each term and its description."""
    path = notes_src / DICTIONARIES / GLOSSARY
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text()) or {}
    terms = data.get("terms") or {}
    if isinstance(terms, list):
        terms = {str(item.get("term")): str(item.get("description", "")) for item in terms if isinstance(item, dict)}
    return {str(term): str(text) for term, text in terms.items()}


def terms_in(text: str, glossary: dict[str, str]) -> list[str]:
    """The glossary terms ``text`` names, as whole words, any case."""
    return [term for term in glossary if re.search(rf"(?<![\w]){re.escape(term)}(?![\w])", text, re.IGNORECASE)]


def dictionary(notes_src: Path, sql: str) -> dict[str, Any]:
    """The tables ``sql`` touches, with each one's dictionary entry or none.

    ``tables``: each as written, with ``entry`` (its full name) when one is found, the entry's file
    text and the glossary terms it names. ``glossary``: those terms' descriptions.
    """
    entries = dictionary_files(notes_src)
    glossary = read_glossary(notes_src)
    tables = []
    used: dict[str, str] = {}
    for name in table_names(sql):
        full = resolve(name, entries)
        if full is None:
            tables.append({"name": name})
            continue
        text = entries[full].read_text()
        terms = terms_in(text, glossary)
        used.update({term: glossary[term] for term in terms})
        tables.append({"name": name, "entry": full, "text": text, "terms": terms})
    return {"tables": tables, "glossary": used}


# ---------------------------------------------------------------------------
# Trusted calculations: <notes-src>/trusted/<name>.sql or <name>.py, with <name>.test.yaml and
# test_<name>.py beside them. A proposal has the same files in an analysis's lib/trusted/.

TRUSTED = "trusted"
NAME = re.compile(r"^[a-z][a-z0-9_]*$")
FRONT = re.compile(r"\A\s*/\*---\s*\n(.*?)\n---\*/[ \t]*\n?", re.DOTALL)
TYPES = ("string", "integer", "number", "boolean", "date")
PY_TYPES = {"str": "string", "int": "integer", "float": "number", "bool": "boolean", "date": "date", "datetime.date": "date"}


class Problem(Exception):
    """What makes a calculation unusable, said for the person."""


def split_template(text: str) -> tuple[dict[str, Any], str]:
    """A SQL template's front matter (the ``/*--- ... ---*/`` block at its top) and its SQL."""
    match = FRONT.match(text)
    if not match:
        raise Problem("no front matter: start the file with a /*--- ... ---*/ block holding description and parameters")
    front = yaml.safe_load(match.group(1)) or {}
    if not isinstance(front, dict):
        raise Problem("the front matter is not a mapping")
    return front, text[match.end() :].strip()


def parameters_of(declared: Any) -> list[dict[str, Any]]:
    """Declared parameters as a list of ``{name, type, required}``: from ``name: type`` or ``name: {type, default}``."""
    found = []
    for name, spec in (declared or {}).items():
        kind, has_default = (spec.get("type"), "default" in spec) if isinstance(spec, dict) else (spec, False)
        if kind not in TYPES:
            raise Problem(f"parameter {name}: type {kind!r} is not one of {', '.join(TYPES)}")
        found.append({"name": str(name), "type": kind, "required": not has_default})
    return found


def placeholders(sql: str) -> set[str]:
    """The ``:name`` parameters a Databricks statement uses, from sqlglot's parse."""
    return {str(node.name) for statement in sqlglot.parse(sql, read=DIALECT) if statement for node in statement.find_all(exp.Placeholder)}


def load_module(path: Path) -> Any:
    """The Python file at ``path`` as a module, imported afresh."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(f"trusted_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise Problem(f"cannot import {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def python_function(path: Path) -> tuple[Any, str, list[dict[str, Any]]]:
    """The function named after the file, its docstring and its parameters after the engine."""
    import inspect

    function = getattr(load_module(path), path.stem, None)
    if not callable(function):
        raise Problem(f"{path.name} has no function {path.stem}")
    doc = inspect.getdoc(function)
    if not doc:
        raise Problem(f"{path.stem} has no docstring")
    params = list(inspect.signature(function).parameters.values())
    if not params:
        raise Problem(f"{path.stem} takes no engine: its first parameter must be the SQLAlchemy engine")
    found = []
    for param in params[1:]:
        annotation = param.annotation if isinstance(param.annotation, str) else getattr(param.annotation, "__name__", "")
        kind = PY_TYPES.get(str(annotation))
        if kind is None:
            raise Problem(f"parameter {param.name}: annotate it with str, int, float, bool or date")
        found.append({"name": param.name, "type": kind, "required": param.default is inspect.Parameter.empty})
    return function, doc, found


def describe(folder: Path, name: str) -> dict[str, Any]:
    """A calculation in ``folder``: its kind, file, one-line description and parameters (and SQL, for a template)."""
    sql, py = folder / f"{name}.sql", folder / f"{name}.py"
    if sql.is_file() == py.is_file():
        raise Problem(f"{name}: need exactly one of {name}.sql and {name}.py in {folder}")
    if sql.is_file():
        front, body = split_template(sql.read_text())
        description = str(front.get("description") or "").strip()
        if not description:
            raise Problem(f"{name}.sql: the front matter has no description")
        params = parameters_of(front.get("parameters"))
        return {"name": name, "kind": "sql", "file": sql.name, "description": description.splitlines()[0], "parameters": params, "sql": body}
    _, doc, params = python_function(py)
    return {"name": name, "kind": "python", "file": py.name, "description": doc.splitlines()[0], "parameters": params}


# ---------------------------------------------------------------------------
# Definitions: a dictionary entry's metrics, filters and derived values, each a Databricks SQL
# expression over its table. They run as `<catalog.schema.table>:<name>`, built into a query here.

DEFINITION_KINDS = ("metric", "filter", "derived")
DERIVED_LIMIT = 100


def read_entry(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise Problem(f"{path.name} is not a mapping")
    return data


def definitions_of(data: dict[str, Any]) -> list[dict[str, Any]]:
    """An entry's definitions, each checked: a name, a kind, a description and an SQL expression."""
    found = []
    for item in data.get("definitions") or []:
        if not isinstance(item, dict):
            raise Problem("each definition is a mapping")
        name = str(item.get("name") or "")
        if not NAME.match(name):
            raise Problem(f"definition {name!r}: a name is lower case, digits and _")
        if item.get("kind") not in DEFINITION_KINDS:
            raise Problem(f"definition {name}: kind is one of {', '.join(DEFINITION_KINDS)}")
        if not str(item.get("sql") or "").strip() or not str(item.get("description") or "").strip():
            raise Problem(f"definition {name}: needs a description and sql")
        found.append(item)
    return found


def definition_parameters(kind: str) -> list[dict[str, Any]]:
    """What a definition's run takes: columns to group or show by, filters of its table, and a limit for a derived value."""
    params = [{"name": "by", "type": "list", "required": False}, {"name": "filters", "type": "list", "required": False}]
    return params + ([{"name": "limit", "type": "integer", "required": False}] if kind == "derived" else [])


def render_definition(data: dict[str, Any], table: str, name: str, values: dict[str, Any]) -> str:
    """The query that runs a definition: names checked against the entry's columns and filters, never pasted in raw.

    metric: ``SELECT <by>, <sql> AS name ... GROUP BY <by>``; filter: the count of rows it keeps, by ``<by>``;
    derived: ``<by>`` (or every column) and the value, at most ``limit`` rows. ``filters`` are the entry's
    filter definitions, ANDed in.
    """
    definitions = {item["name"]: item for item in definitions_of(data)}
    if name not in definitions:
        raise Problem(f"{table} has no definition {name}")
    definition = definitions[name]
    columns = {str(c.get("name")).lower(): str(c.get("name")) for c in data.get("columns") or [] if isinstance(c, dict)}
    by = []
    for column in values.get("by") or []:
        if column.lower() not in columns:
            raise Problem(f"by: {column} is not a column of {table}")
        by.append(f"`{columns[column.lower()]}`")
    where = []
    for filter_name in values.get("filters") or []:
        other = definitions.get(filter_name)
        if not other or other["kind"] != "filter":
            raise Problem(f"filters: {filter_name} is not a filter of {table}")
        where.append(f"({other['sql']})")
    expression = str(definition["sql"]).strip()
    kind = definition["kind"]
    source = ".".join(f"`{part}`" for part in table.split("."))
    if kind == "filter":
        where.insert(0, f"({expression})")
        select = [*by, f"count(*) AS `{name}`"]
    else:
        select = [*(by or (["*"] if kind == "derived" else [])), f"{expression} AS `{name}`"]
    sql = f"SELECT {', '.join(select)} FROM {source}"
    if where:
        sql += f" WHERE {' AND '.join(where)}"
    if by and kind != "derived":
        sql += f" GROUP BY {', '.join(by)}"
    if kind == "derived":
        limit = values.get("limit", DERIVED_LIMIT)
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise Problem("limit must be a positive integer")
        sql += f" LIMIT {limit}"
    return sql


def describe_definition(folder: Path, full: str) -> dict[str, Any]:
    """A definition, by ``<table>:<name>``, in the dictionary folder ``folder``."""
    table, _, name = full.partition(":")
    path = folder / f"{table}.yaml"
    if not path.is_file():
        raise Problem(f"no dictionary entry {table}")
    data = read_entry(path)
    definition = next((item for item in definitions_of(data) if item["name"] == name), None)
    if definition is None:
        raise Problem(f"{table} has no definition {name}")
    return {
        "name": full,
        "kind": "definition",
        "file": path.name,
        "description": f"{definition['kind']} on {table}: {str(definition['description']).strip().splitlines()[0]}",
        "parameters": definition_parameters(definition["kind"]),
        "entry": data,
    }


def git(folder: Path, *args: str) -> str:
    """git's output in ``folder``, or '' when git fails (no repository, no git)."""
    import subprocess

    try:
        ran = subprocess.run(["git", "-C", str(folder), *args], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return ran.stdout.strip() if ran.returncode == 0 else ""


def file_state(folder: Path, file: str) -> dict[str, Any]:
    """The commit that last changed ``file`` and whether it differs from that commit (or was never committed)."""
    commit = git(folder, "log", "-1", "--format=%H", "--", file)
    changed = bool(git(folder, "status", "--porcelain", "--", file))
    return {"commit": commit[:12], "dirty": changed or not commit}


def list_calculations(notes_src: Path) -> dict[str, Any]:
    """Every trusted calculation, with its commit; files that are not usable are listed under ``problems``."""
    folder = notes_src / TRUSTED
    names = sorted({path.stem for path in folder.glob("*") if path.suffix in (".sql", ".py") and NAME.match(path.stem) and not path.stem.startswith("test_")}) if folder.is_dir() else []
    calculations, problems = [], []
    for name in names:
        try:
            found = describe(folder, name)
        except Exception as error:
            problems.append(f"{name}: {error}")
            continue
        calculations.append({**found, "path": f"{TRUSTED}/{found['file']}", **file_state(folder, found["file"])})
    for table, path in sorted(dictionary_files(notes_src).items()):
        try:
            items = definitions_of(read_entry(path))
        except Exception as error:
            problems.append(f"{path.name}: {error}")
            continue
        state = file_state(path.parent, path.name) if items else {}
        for item in items:
            found = describe_definition(path.parent, f"{table}:{item['name']}")
            del found["entry"]
            calculations.append({**found, "path": f"{DICTIONARIES}/{path.name}", **state})
    return {"calculations": calculations, "problems": problems}


def convert(params: list[dict[str, Any]], given: dict[str, Any]) -> dict[str, Any]:
    """The arguments as Python values of their declared types; an unknown, missing or ill-typed one is a Problem."""
    import datetime

    known = {param["name"]: param for param in params}
    unknown = sorted(set(given) - set(known))
    if unknown:
        raise Problem(f"unknown arguments: {', '.join(unknown)}")
    values: dict[str, Any] = {}
    for name, param in known.items():
        if name not in given:
            if param["required"]:
                raise Problem(f"missing argument: {name}")
            continue
        value, kind = given[name], param["type"]
        ok = {
            "string": isinstance(value, str),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool),
            "boolean": isinstance(value, bool),
            "date": isinstance(value, (str, datetime.date)),
            "list": isinstance(value, list) and all(isinstance(each, str) for each in value),
        }[kind]
        if not ok:
            raise Problem(f"argument {name} must be a {'list of names' if kind == 'list' else kind}")
        if kind == "date" and isinstance(value, str):
            try:
                value = datetime.date.fromisoformat(value)
            except ValueError:
                raise Problem(f"argument {name} must be a date as YYYY-MM-DD") from None
        values[name] = value
    return values


def cell(value: Any) -> str:
    """A result value as a run's CSV holds it."""
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def frame_table(frame: Any) -> dict[str, Any]:
    """A pandas or polars data frame as ``{columns, rows}`` of strings."""
    if hasattr(frame, "iter_rows"):  # polars
        return {"columns": [str(c) for c in frame.columns], "rows": [[cell(v) for v in row] for row in frame.iter_rows()]}
    if hasattr(frame, "itertuples"):  # pandas
        return {"columns": [str(c) for c in frame.columns], "rows": [[cell(v) for v in row] for row in frame.itertuples(index=False)]}
    raise Problem(f"the function returned a {type(frame).__name__}, not a data frame")


def render(notes_src: Path, name: str, given: dict[str, Any]) -> str:
    """The SQL a definition's run sends, its arguments checked."""
    found = describe_definition(notes_src / DICTIONARIES, name)
    return render_definition(found["entry"], name.partition(":")[0], name.partition(":")[2], convert(found["parameters"], given))


def run_live_sql(sql: str, analysis: Path) -> dict[str, Any]:
    """Runs SQL that has no parameters (a definition's query) on the analysis's warehouse."""
    import analysis_db

    with analysis_db.engine(start=analysis).connect() as connection:
        result = connection.exec_driver_sql(sql)
        return {"columns": list(result.keys()), "rows": [[cell(v) for v in row] for row in result]}


def run(folder: Path, name: str, given: dict[str, Any], analysis: Path) -> dict[str, Any]:
    """Runs a calculation in ``folder`` on the analysis's warehouse; its result as ``{columns, rows}``.

    A ``<table>:<name>`` is a definition, read from ``dictionaries/`` beside ``folder``.
    """
    import analysis_db

    if ":" in name:
        return run_live_sql(render(folder.parent, name, given), analysis)
    found = describe(folder, name)
    values = convert(found["parameters"], given)
    engine = analysis_db.engine(start=analysis)
    if found["kind"] == "python":
        function, _, _ = python_function(folder / found["file"])
        return frame_table(function(engine, **values))
    from sqlalchemy import text

    with engine.connect() as connection:
        result = connection.execute(text(found["sql"]), values)
        return {"columns": list(result.keys()), "rows": [[cell(v) for v in row] for row in result]}


# ---------------------------------------------------------------------------
# Fixture tests: <name>.test.yaml holds tables (CSV text by table name), cases (args, expect as CSV,
# ordered) and live (the arguments of the live check). They run on DuckDB.


def load_tests(folder: Path, name: str) -> dict[str, Any]:
    """``<name>.test.yaml`` in ``folder``, or an empty one."""
    path = folder / f"{name}.test.yaml"
    data = yaml.safe_load(path.read_text()) if path.is_file() else {}
    return data if isinstance(data, dict) else {}


def _csv_relation(connection: Any, text: str) -> str:
    """A temporary CSV file holding ``text``, as a DuckDB read_csv call."""
    import tempfile

    handle = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False)
    handle.write(text if text.endswith("\n") else f"{text}\n")
    handle.close()
    return f"read_csv('{handle.name}', header = true)"


# Database names DuckDB keeps for itself; a fixture catalog of that name is attached with a _ after it,
# and SQL templates are rewritten to match (Unity Catalog's default catalog is often `main`).
RESERVED_CATALOGS = {"main", "system", "temp", "memory"}


def fixture_catalog(name: str) -> str:
    """The DuckDB database a fixture table's catalog becomes."""
    return f"{name}_" if name.lower() in RESERVED_CATALOGS else name


def create_tables(connection: Any, tables: dict[str, str]) -> None:
    """Creates each fixture table on a DuckDB connection: a three-part name gets its catalog attached."""
    attached = {row[0] for row in connection.execute("SELECT database_name FROM duckdb_databases()").fetchall()}
    for full, text in (tables or {}).items():
        parts = str(full).lower().split(".")
        if len(parts) == 3:
            parts[0] = fixture_catalog(parts[0])
        if len(parts) == 3 and parts[0] not in attached:
            connection.execute(f'ATTACH \':memory:\' AS "{parts[0]}"')
            attached.add(parts[0])
        quoted = ".".join(f'"{part}"' for part in parts)
        if len(parts) >= 2:
            connection.execute(f"CREATE SCHEMA IF NOT EXISTS {quoted.rsplit('.', 1)[0]}")
        connection.execute(f"CREATE TABLE {quoted} AS SELECT * FROM {_csv_relation(connection, str(text))}")


def fixture_engine(tables: dict[str, str]) -> Any:
    """A SQLAlchemy engine on an in-memory DuckDB holding ``tables``: for a Python calculation's own tests."""
    from sqlalchemy import create_engine
    from sqlalchemy.pool import StaticPool

    engine = create_engine("duckdb:///:memory:", poolclass=StaticPool)
    raw = engine.raw_connection()
    create_tables(raw.driver_connection, tables)
    raw.close()
    return engine


def to_duckdb(sql: str) -> str:
    """A Databricks statement as DuckDB SQL for the fixtures; a Problem when sqlglot cannot transpile it.

    ``:name`` becomes ``$name``, and a catalog DuckDB reserves is renamed as ``fixture_catalog`` does.
    """
    try:
        statements = [statement for statement in sqlglot.parse(sql, read=DIALECT) if statement is not None]
        if len(statements) != 1:
            raise Problem(f"is {len(statements)} statements, not one")
        statement = statements[0]
        for table in statement.find_all(exp.Table):
            if table.catalog:
                table.set("catalog", exp.to_identifier(fixture_catalog(table.catalog.lower())))
        return statement.sql(dialect="duckdb", unsupported_level=sqlglot.ErrorLevel.RAISE)
    except Problem:
        raise
    except Exception as error:
        raise Problem(f"does not transpile to DuckDB: {error}") from None


def _comparable(value: Any) -> Any:
    from decimal import Decimal

    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return round(float(value), 9)
    return cell(value)


def rows_of(connection: Any, sql: str, params: dict[str, Any] | None = None) -> tuple[list[str], list[tuple[Any, ...]]]:
    result = connection.execute(sql, params or {})
    return [d[0] for d in result.description], [tuple(_comparable(v) for v in row) for row in result.fetchall()]


class Mismatch(AssertionError):
    """A fixture case's result differs from its expected CSV; ``diff`` shows both as CSV lines."""

    def __init__(self, message: str, diff: str) -> None:
        super().__init__(message)
        self.diff = diff


DIFF_LINES = 40


def csv_lines(columns: list[str], rows: list[tuple[Any, ...]]) -> list[str]:
    import csv
    import io

    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow(["" if value is None else value for value in row])
    return out.getvalue().splitlines()


def line_diff(expected: list[str], got: list[str], limit: int = DIFF_LINES) -> str:
    """``expected`` against ``got``: ``  `` same, ``- `` expected only, ``+ `` got only; ``limit`` lines, then a count."""
    import difflib

    lines: list[str] = []
    for tag, a0, a1, b0, b1 in difflib.SequenceMatcher(None, expected, got, autojunk=False).get_opcodes():
        if tag == "equal":
            lines += [f"  {line}" for line in expected[a0:a1]]
        else:
            lines += [f"- {line}" for line in expected[a0:a1]] + [f"+ {line}" for line in got[b0:b1]]
    if len(lines) > limit:
        return "\n".join([*lines[:limit], f"… {len(lines) - limit} more"])
    return "\n".join(lines)


def compare(columns: list[str], rows: list[tuple[Any, ...]], expected: str, ordered: bool) -> None:
    """Asserts a result equals the expected CSV: same columns, same rows (in order when ``ordered``)."""
    import duckdb

    connection = duckdb.connect()
    want_columns, want_rows = rows_of(connection, f"SELECT * FROM {_csv_relation(connection, expected)}")
    key = lambda row: tuple((v is None, repr(v)) for v in row)  # noqa: E731
    got, want = (rows, want_rows) if ordered else (sorted(rows, key=key), sorted(want_rows, key=key))
    if columns != want_columns:
        message = f"columns {columns} != expected {want_columns}"
    elif got != want:
        message = f"rows {got} != expected {want}"
    else:
        return
    raise Mismatch(message, line_diff(csv_lines(want_columns, want), csv_lines(columns, got)))


def run_case(folder: Path, name: str, index: int) -> None:
    """Runs case ``index`` of a calculation's fixture tests on DuckDB; a failed comparison raises."""
    import duckdb

    tests = load_tests(folder, name)
    case = (tests.get("cases") or [])[index]
    if name.count(".") == 2 and (folder / f"{name}.yaml").is_file():
        # A dictionary entry's case runs one of its definitions.
        data = read_entry(folder / f"{name}.yaml")
        definition = str(case.get("definition") or "")
        kind = next((item["kind"] for item in definitions_of(data) if item["name"] == definition), "metric")
        values = convert(definition_parameters(kind), case.get("args") or {})
        connection = duckdb.connect()
        create_tables(connection, tests.get("tables") or {})
        columns, rows = rows_of(connection, to_duckdb(render_definition(data, name, definition, values)))
        compare(columns, rows, str(case.get("expect", "")), bool(case.get("ordered")))
        return
    found = describe(folder, name)
    values = convert(found["parameters"], case.get("args") or {})
    if found["kind"] == "sql":
        connection = duckdb.connect()
        create_tables(connection, tests.get("tables") or {})
        columns, rows = rows_of(connection, to_duckdb(found["sql"]), values)
    else:
        function, _, _ = python_function(folder / found["file"])
        table = frame_table(function(fixture_engine(tests.get("tables") or {}), **values))
        connection = duckdb.connect()
        columns = table["columns"]
        rows = [tuple(_comparable(_parse(v)) for v in row) for row in table["rows"]]
    compare(columns, rows, str(case.get("expect", "")), bool(case.get("ordered")))


def _parse(text: str) -> Any:
    """A CSV cell back as a number when it reads as one, so a frame compares like a query."""
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return text


CASES_MODULE = """import pytest
from pathlib import Path
import analysis_trust

FOLDER = Path({folder!r})
NAME = {name!r}


@pytest.mark.parametrize("index", range({count}))
def test_case(index):
    analysis_trust.run_case(FOLDER, NAME, index)
"""

# A pytest plugin written into the scratch folder: one marked line per test report, read from piped stdout.
STREAM_MARK = "@@assay-test@@"
STREAM_PLUGIN = """import json
import os
import re
import sys

import pytest

CASES = os.environ.get("ASSAY_CASES_MODULE", "")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if call.excinfo is not None:
        error = call.excinfo.value
        lines = str(error).strip().splitlines()
        report.assay_text = (lines[0] if lines else type(error).__name__)[:300]
        report.assay_diff = getattr(error, "diff", None)


def pytest_runtest_logreport(report):
    if report.when != "call" and report.passed:
        return
    if report.when != "call" and report.skipped:
        return
    path, _, name = report.location
    base = os.path.basename(path)
    name = name.replace(".", "::")
    found = re.fullmatch(r"test_case\\[(\\d+)\\]", name)
    if base == CASES and found:
        name = "case %d" % (int(found.group(1)) + 1)
    else:
        name = base + "::" + name
    event = {"name": name, "ok": report.passed, "text": "PASSED" if report.passed else "FAILED"}
    if report.skipped:
        event["text"] = "SKIPPED"
    elif not report.passed:
        detail = getattr(report, "assay_text", "")
        if detail:
            event["text"] += " " + detail
        if getattr(report, "assay_diff", None):
            event["diff"] = report.assay_diff
    sys.stdout.write("\\n" + {mark!r} + json.dumps(event) + "\\n")
    sys.stdout.flush()
"""


def run_tests(folder: Path, name: str, on_test: Any = None) -> dict[str, Any]:
    """pytest over the fixture cases and ``test_<name>.py``.

    Returns whether all passed, pytest's last lines and ``results``, one ``{name, ok, text, diff?}`` per test.
    ``on_test`` is called with each result when pytest reports it.
    """
    import os
    import subprocess
    import tempfile
    import threading

    count = len(load_tests(folder, name).get("cases") or [])
    own = folder / f"test_{name}.py"
    if count == 0 and not own.is_file():
        return {"passed": False, "output": f"no tests: add cases to {name}.test.yaml or write test_{name}.py"}
    targets = []
    results: list[dict[str, Any]] = []
    lines: list[str] = []
    with tempfile.TemporaryDirectory() as scratch:
        cases = ""
        if count:
            cases = f"test_cases_{re.sub(r'[^A-Za-z0-9_]', '_', name)}.py"
            module = Path(scratch) / cases
            module.write_text(CASES_MODULE.format(folder=str(folder), name=name, count=count))
            targets.append(str(module))
        if own.is_file():
            targets.append(str(own))
        (Path(scratch) / "assay_stream.py").write_text(STREAM_PLUGIN.replace("{mark!r}", repr(STREAM_MARK)))
        env = {**os.environ, "ASSAY_CASES_MODULE": cases, "PYTHONPATH": os.pathsep.join(filter(None, [scratch, os.environ.get("PYTHONPATH", "")]))}
        process = subprocess.Popen(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "assay_stream", "--rootdir", scratch, *targets],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=str(folder),
            env=env,
        )
        timer = threading.Timer(300, process.kill)
        timer.start()
        try:
            assert process.stdout is not None
            for line in process.stdout:
                line = line.rstrip("\n")
                at = line.find(STREAM_MARK)
                if at >= 0:
                    try:
                        result = json.loads(line[at + len(STREAM_MARK) :])
                    except ValueError:
                        continue
                    results.append(result)
                    if on_test is not None:
                        on_test(result)
                elif line.strip():
                    lines.append(line)
            code = process.wait()
        finally:
            timer.cancel()
    return {"passed": code == 0, "output": "\n".join(lines[-12:]), "results": results}


def test_step(result: dict[str, Any]) -> dict[str, Any]:
    step = {"step": "test", "ok": result["ok"], "text": result["text"], "name": result["name"]}
    if result.get("diff"):
        step["diff"] = result["diff"]
    return step


def test_steps(tests: dict[str, Any], emit: Any) -> bool:
    """What a test run leaves after its per-test steps: a failing ``tests`` step when pytest itself failed
    (or there was no test). ``emit`` is called with it. True when every test passed."""
    if not tests.get("results") and not tests["passed"]:
        emit({"step": "tests", "ok": False, "text": tests["output"]})
        return False
    if not tests["passed"] and all(result["ok"] for result in tests.get("results") or []):
        emit({"step": "tests", "ok": False, "text": tests["output"]})
        return False
    return tests["passed"]


SAMPLE_ROWS = 5


def plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


class Steps:
    """The steps of a check, kept for the answer and, when streaming, passed on as they happen."""

    def __init__(self, emit: Any = None) -> None:
        self.steps: list[dict[str, Any]] = []
        self.emit = emit

    def __call__(self, step: dict[str, Any]) -> None:
        self.steps.append(step)
        if self.emit is not None:
            self.emit({"event": "step", "step": step})

    def start(self, answer: dict[str, Any]) -> None:
        if self.emit is not None:
            keys = ("name", "kind", "file", "description", "code", "files")
            self.emit({"event": "start", **{key: answer[key] for key in keys if key in answer}})

    def tests(self, folder: Path, name: str) -> bool:
        """Runs the tests, one step each as pytest reports it; whether every one passed."""
        result = run_tests(folder, name, lambda found: self(test_step(found)))
        if "results" not in result:
            self({"step": "tests", "ok": False, "text": result["output"]})
            return False
        return test_steps(result, self)


def check(folder: Path, name: str, analysis: Path, emit: Any = None) -> dict[str, Any]:
    """What the Trust tab shows for a proposal: its code, the tests, the transpile check and a live run.

    ``ok`` is true only when every step passed: only then may the person approve it. ``emit`` gets each
    event (``start``, ``step``) as it happens.
    """
    answer: dict[str, Any] = {"name": name, "ok": False, "steps": []}
    step = Steps(emit)
    step.steps = answer["steps"]
    try:
        found = describe(folder, name)
    except Exception as error:
        step({"step": "form", "ok": False, "text": str(error)})
        return answer
    answer.update(kind=found["kind"], file=found["file"], description=found["description"], code=(folder / found["file"]).read_text())
    files = [found["file"], *(f for f in (f"{name}.test.yaml", f"test_{name}.py") if (folder / f).is_file())]
    answer["files"] = files
    step.start(answer)
    what = "SQL template" if found["kind"] == "sql" else "Python function"
    step({"step": "form", "ok": True, "text": f"{what}, {plural(len(found['parameters']), 'parameter')}"})
    if found["kind"] == "sql":
        try:
            declared = {param["name"] for param in found["parameters"]}
            used = placeholders(found["sql"])
            if used != declared:
                raise Problem(f"uses :{', :'.join(sorted(used)) or '(none)'} but declares {', '.join(sorted(declared)) or 'none'}")
            step({"step": "transpile", "ok": True, "text": to_duckdb(found["sql"])})
        except Exception as error:
            step({"step": "transpile", "ok": False, "text": str(error)})
            return answer
    if not step.tests(folder, name):
        return answer
    live_args = load_tests(folder, name).get("live")
    if live_args is None and any(param["required"] for param in found["parameters"]):
        step({"step": "live", "ok": False, "text": f"no live: arguments in {name}.test.yaml for the live run"})
        return answer
    try:
        table = run(folder, name, live_args or {}, analysis)
    except Exception as error:
        step({"step": "live", "ok": False, "text": f"{type(error).__name__}: {error}"})
        return answer
    rows = table["rows"]
    step({"step": "live", "ok": True, "text": f"{plural(len(rows), 'row')} with {json.dumps(live_args or {}, default=str)}"})
    answer.update(ok=True, sample={"columns": table["columns"], "rows": rows[:SAMPLE_ROWS], "total": len(rows)})
    return answer


# ---------------------------------------------------------------------------
# The command line.


def check_entry(path: Path, analysis: Path, emit: Any = None) -> dict[str, Any]:
    """What the Trust tab shows for a drafted dictionary entry: its text and whether its form is sound."""
    name = path.name[: -len(".yaml")]
    answer: dict[str, Any] = {"name": name, "ok": False, "steps": [], "kind": "dictionary", "file": path.name}
    step = Steps(emit)
    step.steps = answer["steps"]
    try:
        answer["code"] = path.read_text()
        data = yaml.safe_load(answer["code"])
        if name.count(".") != 2:
            raise Problem("name the file catalog.schema.table.yaml")
        if not isinstance(data, dict) or not str(data.get("description") or "").strip():
            raise Problem("needs a description")
        columns = data.get("columns") or []
        if not isinstance(columns, list) or not all(isinstance(c, dict) and c.get("name") for c in columns):
            raise Problem("columns must be a list, each with a name")
    except Exception as error:
        step({"step": "form", "ok": False, "text": str(error)})
        return answer
    answer["description"] = str(data["description"]).strip().splitlines()[0]
    answer["files"] = [path.name, *([f"{name}.test.yaml"] if (path.parent / f"{name}.test.yaml").is_file() else [])]
    step.start(answer)
    step({"step": "form", "ok": True, "text": plural(len(columns), "column")})
    try:
        definitions = definitions_of(data)
        for item in definitions:
            to_duckdb(render_definition(data, name, item["name"], {}))
    except Exception as error:
        step({"step": "transpile", "ok": False, "text": str(error)})
        return answer
    if not definitions:
        answer["ok"] = True
        return answer
    step({"step": "transpile", "ok": True, "text": plural(len(definitions), "definition")})
    tests = load_tests(path.parent, name)
    tested = {str(case.get("definition")) for case in tests.get("cases") or [] if isinstance(case, dict)}
    untested = [item["name"] for item in definitions if item["name"] not in tested]
    if untested:
        step({"step": "tests", "ok": False, "text": f"no case in {name}.test.yaml for {', '.join(untested)}"})
        return answer
    if not step.tests(path.parent, name):
        return answer
    live = tests.get("live") or {}
    said = []
    for item in definitions:
        try:
            values = convert(definition_parameters(item["kind"]), live.get(item["name"]) or {})
            table = run_live_sql(render_definition(data, name, item["name"], values), analysis)
        except Exception as error:
            step({"step": "live", "ok": False, "text": f"{item['name']}: {type(error).__name__}: {error}"})
            return answer
        rows = table["rows"]
        said.append(f"{item['name']} {plural(len(rows), 'row')}")
        answer.setdefault("sample", {"columns": table["columns"], "rows": rows[:SAMPLE_ROWS], "total": len(rows)})
    step({"step": "live", "ok": True, "text": ", ".join(said)})
    answer["ok"] = True
    return answer


USAGE = """usage: python -m analysis_trust <command> ...
  dictionary <notes-src> <sql-file>
  list <notes-src>
  run <notes-src> <name> <args-json> <analysis>
  render <notes-src> <table:definition> <args-json>
  check <folder> <name> <analysis> [--stream]
  check-entry <draft-file> <analysis> [--stream]"""


def stream_check(command: str, args: list[str]) -> int:
    """``check`` or ``check-entry`` with ``--stream``: one JSON line per event, flushed; the last is ``done``."""

    def emit(event: dict[str, Any]) -> None:
        print(json.dumps(event, default=str), flush=True)

    try:
        if command == "check" and len(args) == 3:
            answer = check(Path(args[0]), args[1], Path(args[2]), emit)
        elif command == "check-entry" and len(args) == 2:
            answer = check_entry(Path(args[0]), Path(args[1]), emit)
        else:
            answer = {"error": f"{USAGE}\ngot: {command} {args} --stream"}
    except Exception as error:
        answer = {"error": f"{type(error).__name__}: {error}"}
    emit({"event": "done", "answer": answer})
    return 1 if "error" in answer else 0


def main(argv: list[str]) -> int:
    command, *args = argv or [""]
    if command in ("check", "check-entry") and args and args[-1] == "--stream":
        return stream_check(command, args[:-1])
    try:
        if command == "dictionary" and len(args) == 2:
            answer = dictionary(Path(args[0]), Path(args[1]).read_text())
        elif command == "list" and len(args) == 1:
            answer = list_calculations(Path(args[0]))
        elif command == "run" and len(args) == 4:
            given = json.loads(args[2])
            if not isinstance(given, dict):
                raise Problem("the arguments are not a JSON object")
            answer = run(Path(args[0]) / TRUSTED, args[1], given, Path(args[3]))
        elif command == "check" and len(args) == 3:
            answer = check(Path(args[0]), args[1], Path(args[2]))
        elif command == "render" and len(args) == 3:
            given = json.loads(args[2])
            if not isinstance(given, dict):
                raise Problem("the arguments are not a JSON object")
            answer = {"sql": render(Path(args[0]), args[1], given)}
        elif command == "check-entry" and len(args) == 2:
            answer = check_entry(Path(args[0]), Path(args[1]))
        else:
            answer = {"error": f"{USAGE}\ngot: {argv}"}
    except Problem as problem:
        answer = {"error": str(problem)}
    except Exception as error:  # The server reads every failure from stdout.
        answer = {"error": f"{type(error).__name__}: {error}"}
    print(json.dumps(answer, default=str))
    return 1 if "error" in answer else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

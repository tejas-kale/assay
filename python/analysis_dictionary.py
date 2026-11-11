"""The data dictionary: ``<notes-src>/dictionaries/<catalog>.<schema>.<table>.yaml`` and ``glossary.yaml``.

An entry describes a table and may hold definitions: metrics, filters and derived values, each a Databricks SQL
expression over its table. They run as ``<catalog.schema.table>:<name>``, built into a query here.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import sqlglot
import yaml
from sqlglot import exp

from analysis_calc import DIALECT, NAME, TrustError

DICTIONARIES = "dictionaries"
GLOSSARY = "glossary.yaml"
# A table's full name: catalog.schema.table.
FULL_NAME_DOTS = 2
DEFINITION_KINDS = ("metric", "filter", "derived")
DERIVED_LIMIT = 100


# ---------------------------------------------------------------------------
# Tables a statement touches.


def table_names(sql: str, dialect: str = DIALECT) -> list[str]:
    """The tables ``sql`` reads, as written (``catalog.schema.table``, ``schema.table`` or ``table``), sorted.

    CTE names are left out; so are table functions. Names are lower-cased: Unity Catalog names are
    case-insensitive.
    """
    found: set[str] = set()
    for statement in sqlglot.parse(sql, read=dialect):
        if statement is not None:
            found.update(_tables_read(statement))
    return sorted(found)


def _tables_read(statement: exp.Expression) -> list[str]:
    ctes = {cte.alias_or_name.lower() for cte in statement.find_all(exp.CTE)}
    names = []
    for table in statement.find_all(exp.Table):
        if not table.name or isinstance(table.this, exp.Func):
            continue
        parts = [part for part in (table.catalog, table.db, table.name) if part]
        if len(parts) == 1 and parts[0].lower() in ctes:
            continue
        names.append(".".join(parts).lower())
    return names


# ---------------------------------------------------------------------------
# Entries and the glossary.


def dictionary_files(notes_src: Path) -> dict[str, Path]:
    """Each table's entry by its full name, lower-cased; the glossary and test files are not entries."""
    folder = notes_src / DICTIONARIES
    if not folder.is_dir():
        return {}
    entries = {}
    for path in folder.glob("*.yaml"):
        name = path.name[: -len(".yaml")].lower()
        if path.name == GLOSSARY or name.endswith(".test") or name.count(".") != FULL_NAME_DOTS:
            continue
        entries[name] = path
    return entries


def is_full_name(name: str) -> bool:
    return name.count(".") == FULL_NAME_DOTS


def resolve(name: str, entries: dict[str, Path]) -> str | None:
    """The full name of the entry ``name`` stands for: itself, or the one entry ending in it."""
    if name in entries:
        return name
    if is_full_name(name):
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


def read_entry(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise TrustError(f"{path.name} is not a mapping")
    return data


# ---------------------------------------------------------------------------
# Definitions.


def definitions_of(data: dict[str, Any]) -> list[dict[str, Any]]:
    """An entry's definitions, each checked: a name, a kind, a description and an SQL expression."""
    found = []
    for item in data.get("definitions") or []:
        if not isinstance(item, dict):
            raise TrustError("each definition is a mapping")
        name = str(item.get("name") or "")
        if not NAME.match(name):
            raise TrustError(f"definition {name!r}: a name is lower case, digits and _")
        if item.get("kind") not in DEFINITION_KINDS:
            raise TrustError(f"definition {name}: kind is one of {', '.join(DEFINITION_KINDS)}")
        if not str(item.get("sql") or "").strip() or not str(item.get("description") or "").strip():
            raise TrustError(f"definition {name}: needs a description and sql")
        found.append(item)
    return found


def definition_parameters(kind: str) -> list[dict[str, Any]]:
    """What a definition's run takes: columns to group or show by, filters of its table, a limit for a derived value."""
    params = [{"name": "by", "type": "list", "required": False}, {"name": "filters", "type": "list", "required": False}]
    return params + ([{"name": "limit", "type": "integer", "required": False}] if kind == "derived" else [])


def render_definition(data: dict[str, Any], table: str, name: str, values: dict[str, Any]) -> str:
    """The query that runs a definition: names checked against the entry's columns and filters, never pasted in raw.

    metric: ``SELECT <by>, <sql> AS name ... GROUP BY <by>``; filter: the count of rows it keeps, by ``<by>``;
    derived: ``<by>`` (or every column) and the value, at most ``limit`` rows. ``filters`` are the entry's
    filter definitions, ANDed in. A metric or filter starts with its ``-- grain:`` line: the ``by`` columns, or none.
    """
    definitions = {item["name"]: item for item in definitions_of(data)}
    if name not in definitions:
        raise TrustError(f"{table} has no definition {name}")
    kind, expression = definitions[name]["kind"], str(definitions[name]["sql"]).strip()
    by_names = _by_columns(data, table, values.get("by") or [])
    by = [f"`{column}`" for column in by_names]
    where = _filter_expressions(definitions, table, values.get("filters") or [])
    if kind == "filter":
        where.insert(0, f"({expression})")
        select = [*by, f"count(*) AS `{name}`"]
    else:
        select = [*(by or (["*"] if kind == "derived" else [])), f"{expression} AS `{name}`"]
    source = ".".join(f"`{part}`" for part in table.split("."))
    # The grain line (docs/slice-9.md): a derived value has none, since its `by` only picks the columns shown.
    grain = "" if kind == "derived" else f"-- grain: {', '.join(by_names) or 'none'}\n"
    sql = f"{grain}SELECT {', '.join(select)} FROM {source}"
    if where:
        sql += f" WHERE {' AND '.join(where)}"
    if kind == "derived":
        return f"{sql} LIMIT {_derived_limit(values)}"
    return f"{sql} GROUP BY {', '.join(by)}" if by else sql


def _by_columns(data: dict[str, Any], table: str, wanted: list[str]) -> list[str]:
    """The ``by`` columns as the entry spells them; a TrustError for one the entry does not have."""
    columns = {str(c.get("name")).lower(): str(c.get("name")) for c in data.get("columns") or [] if isinstance(c, dict)}
    for column in wanted:
        if column.lower() not in columns:
            raise TrustError(f"by: {column} is not a column of {table}")
    return [columns[column.lower()] for column in wanted]


def _filter_expressions(definitions: dict[str, dict[str, Any]], table: str, wanted: list[str]) -> list[str]:
    where = []
    for filter_name in wanted:
        other = definitions.get(filter_name)
        if not other or other["kind"] != "filter":
            raise TrustError(f"filters: {filter_name} is not a filter of {table}")
        where.append(f"({other['sql']})")
    return where


def _derived_limit(values: dict[str, Any]) -> int:
    limit = values.get("limit", DERIVED_LIMIT)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise TrustError("limit must be a positive integer")
    return limit


def describe_definition(folder: Path, full: str) -> dict[str, Any]:
    """A definition, by ``<table>:<name>``, in the dictionary folder ``folder``."""
    table, _, name = full.partition(":")
    path = folder / f"{table}.yaml"
    if not path.is_file():
        raise TrustError(f"no dictionary entry {table}")
    data = read_entry(path)
    definition = next((item for item in definitions_of(data) if item["name"] == name), None)
    if definition is None:
        raise TrustError(f"{table} has no definition {name}")
    summary = str(definition["description"]).strip().splitlines()[0]
    return {
        "name": full,
        "kind": "definition",
        "file": path.name,
        "description": f"{definition['kind']} on {table}: {summary}",
        "parameters": definition_parameters(definition["kind"]),
        "entry": data,
    }

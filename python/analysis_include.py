"""Include by name (docs/slice-10.md, slice 10c): Claude's SQL names trusted blocks and dictionary definitions, and
they are expanded here before the query runs.

    sessions AS ({{ client_entry_sessions(start => '2026-11-01', end => '2026-11-08') }})   a block, as a CTE body
    WHERE {{ client_entry(s) }}                                                              a definition, on alias s
"""

from __future__ import annotations

import datetime
import re
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

import sqlglot
from sqlglot import exp

import analysis_calc
import analysis_dictionary
import analysis_library
from analysis_sqlread import check_dialect

INCLUDE = re.compile(r"\{\{\s*(?P<name>[A-Za-z_][\w.]*(?::[A-Za-z_]\w*)?)\s*\((?P<args>[^{}]*)\)\s*\}\}")
CTE_OPEN = re.compile(r"(?P<cte>[A-Za-z_]\w*)\s+AS\s*\(\s*$", re.IGNORECASE)
NAMED_ARG = re.compile(r"^\s*([A-Za-z_]\w*)\s*=>\s*(.*?)\s*$", re.DOTALL)
ALIAS = re.compile(r"[A-Za-z_]\w*")
# The retype check reads an included definition as TRUE, so the include itself is never flagged.
RETYPE_INCLUDE = "TRUE"


class Pieces:
    """The trusted pieces under a root: blocks and other templates by name, definitions by full and short name.

    They are listed when first asked for, so SQL that includes nothing never lists them.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    @cached_property
    def _listed(self) -> list[dict[str, Any]]:
        return analysis_library.list_calculations(self.root)["calculations"]

    @cached_property
    def calcs(self) -> dict[str, dict[str, Any]]:
        return {calc["name"]: calc for calc in self._listed if calc["kind"] != "definition"}

    @cached_property
    def definitions(self) -> dict[str, dict[str, Any]]:
        return {calc["name"]: calc for calc in self._listed if calc["kind"] == "definition"}

    @cached_property
    def short(self) -> dict[str, list[str]]:
        found: dict[str, list[str]] = {}
        for full in self.definitions:
            found.setdefault(full.partition(":")[2], []).append(full)
        return found

    def definition(self, name: str) -> tuple[str | None, str | None]:
        """The full name of definition ``name`` (full or short), or why there is none."""
        if ":" in name:
            return (name, None) if name in self.definitions else (None, f"no definition {name}")
        found = self.short.get(name, [])
        if len(found) == 1:
            return found[0], None
        if found:
            return None, f"{name} names definitions on several tables: write one of {', '.join(sorted(found))}"
        return None, None

    def item(self, full: str) -> dict[str, Any]:
        """Definition ``full``'s entry item: its ``kind``, ``sql`` and description."""
        table, _, name = full.partition(":")
        entry = analysis_dictionary.read_entry(self.root / analysis_dictionary.DICTIONARIES / f"{table}.yaml")
        return next(item for item in analysis_dictionary.definitions_of(entry) if item["name"] == name)

    def expression(self, full: str) -> str:
        return str(self.item(full)["sql"]).strip()


def expand(sql: str, dialect: str, root: Path | str, inside_block: str | None = None) -> dict[str, Any]:
    """``sql`` with its included blocks and definitions expanded (docs/slice-10.md, "Expansion").

    ``sql`` runs; ``lint_sql`` is the SQL as written with each block body replaced by ``SELECT <its columns> FROM
    <block>`` and each definition expanded; ``retype_sql`` has each definition read as TRUE; ``built_from`` lists the
    pieces in order of first use, ``blocks`` which CTE holds which block. ``{"errors": [...]}`` when a piece is unknown,
    misused or not trusted as committed. ``inside_block`` names the block ``sql`` is the body of.
    """
    return expand_with(sql, dialect, Pieces(Path(root)), inside_block)


def expand_with(sql: str, dialect: str, pieces: Pieces, inside_block: str | None = None) -> dict[str, Any]:
    """``expand`` with the pieces already at hand."""
    check_dialect(dialect)
    if "{{" not in sql:
        return {"sql": sql, "lint_sql": sql, "retype_sql": sql, "built_from": [], "blocks": []}
    expansion = _Expansion(pieces, dialect, inside_block)
    outs: tuple[list[str], list[str], list[str]] = ([], [], [])
    at = 0
    for match in INCLUDE.finditer(sql):
        before = sql[at : match.start()]
        for out, replacement in zip(outs, expansion.replace(sql, match), strict=True):
            out += [before, replacement]
        at = match.end()
    if expansion.errors:
        return {"errors": expansion.errors}
    run, lint_sql, retype_sql = ("".join(out) + sql[at:] for out in outs)
    built_from = list(expansion.built.values())
    return {
        "sql": run, "lint_sql": lint_sql, "retype_sql": retype_sql,
        "built_from": built_from, "blocks": expansion.blocks,
    }


@dataclass
class _Expansion:
    """What expanding one SQL text found: its errors, the pieces it is built from and the CTEs that hold blocks."""

    pieces: Pieces
    dialect: str
    inside_block: str | None
    errors: list[str] = field(default_factory=list)
    built: dict[str, dict[str, Any]] = field(default_factory=dict)
    blocks: list[dict[str, str]] = field(default_factory=list)

    def replace(self, sql: str, match: re.Match[str]) -> tuple[str, str, str]:
        """What include ``match`` becomes in the SQL that runs, the SQL the rules read and the SQL the retype check
        reads; on an error, the include as written."""
        name, written = match.group("name"), match.group(0)
        unchanged = (written, written, RETYPE_INCLUDE)
        full, problem = self.pieces.definition(name)
        calc = self.pieces.calcs.get(name)
        if problem:
            self.errors.append(f"{written}: {problem}.")
        elif full:
            return self._definition(match, full) or unchanged
        elif calc and "block" in calc:
            return self._block(sql, match, calc) or unchanged
        elif calc:
            self.errors.append(
                f"{written}: {name} is a calculation, not a block or definition: run it whole with the trusted tool, "
                "or propose a block.",
            )
        else:
            self.errors.append(f"{written}: no trusted block or definition named {name}.")
        return unchanged

    def _use(self, name: str, kind: str, calc: dict[str, Any]) -> bool:
        """Records piece ``name`` as used, unless it differs from its last commit."""
        if calc.get("dirty"):
            self.errors.append(
                f"{name} differs from its last commit, or was never committed: it is not trusted until the user "
                "approves it again",
            )
            return False
        self.built.setdefault(name, {"name": name, "kind": kind, "commit": calc.get("commit", "")})
        return True

    def _definition(self, match: re.Match[str], full: str) -> tuple[str, str, str] | None:
        """A definition on the alias it is given, in parentheses."""
        name, written, alias = match.group("name"), match.group(0), match.group("args").strip()
        if not ALIAS.fullmatch(alias):
            self.errors.append(f"{written}: a definition takes the alias of its table, e.g. {{{{ {name}(s) }}}}.")
            return None
        if not self._use(full, "definition", self.pieces.definitions[full]):
            return None
        expression = _qualified(self.pieces.expression(full), alias, self.dialect)
        return expression, expression, RETYPE_INCLUDE

    def _block(self, sql: str, match: re.Match[str], calc: dict[str, Any]) -> tuple[str, str, str] | None:
        """A block as the whole body of a CTE, its parameters bound; the rules and the retype check read its columns."""
        name, written = match.group("name"), match.group(0)
        opened = CTE_OPEN.search(sql[: match.start()])
        if self.inside_block:
            inside = self.inside_block
            self.errors.append(f"{written}: block {inside} includes block {name}; a block includes definitions only.")
            return None
        if not opened or not re.match(r"\s*\)", sql[match.end() :]):
            self.errors.append(f"{written}: a block is the whole body of a CTE, e.g. sessions AS ({written}).")
            return None
        values = self._values(match, calc)
        if values is None or not self._use(name, "block", calc):
            return None
        body = expand_with(calc["sql"], "databricks", self.pieces, inside_block=name)
        if body.get("errors"):
            self.errors.extend(body["errors"])
            return None
        for piece in body["built_from"]:
            self.built.setdefault(piece["name"], piece)
        self.blocks.append({"cte": opened.group("cte"), "name": name})
        columns = f"SELECT {', '.join(calc['block']['columns'])} FROM {name}"
        return _bind(body["sql"], values, self.dialect), columns, columns

    def _values(self, match: re.Match[str], calc: dict[str, Any]) -> dict[str, Any] | None:
        """A block's arguments, checked against its parameters; None, with the error said, when they do not fit."""
        params = calc["parameters"]
        try:
            return analysis_calc.convert(params, _block_args(params, match.group("args")))
        except Exception as error:
            signature = ", ".join(p["name"] + ("" if p["required"] else "?") + ": " + p["type"] for p in params)
            self.errors.append(f"{match.group(0)}: {error}; {match.group('name')}({signature}).")
            return None


def _split_args(text: str) -> list[str]:
    """Arguments split at commas outside quotes."""
    parts, current, quoted = [], "", False
    for char in text:
        if char == "'":
            quoted = not quoted
        if char == "," and not quoted:
            parts.append(current)
            current = ""
        else:
            current += char
    if current.strip() or parts:
        parts.append(current)
    return [part.strip() for part in parts]


def _literal(text: str) -> Any:
    """An argument's value: a quoted string, a number, true, false or null."""
    if len(text) > 1 and text[0] == text[-1] == "'":
        return text[1:-1].replace("''", "'")
    lowered = text.lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    if lowered == "null":
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        raise ValueError(f"{text!r} is not a literal: quote strings and dates ('2026-11-01')") from None


def _block_args(params: list[dict[str, Any]], text: str) -> dict[str, Any]:
    """A block's arguments by name, from ``p => value`` or values in declared order."""
    given: dict[str, Any] = {}
    for i, part in enumerate(_split_args(text)):
        named = NAMED_ARG.match(part)
        if named:
            given[named.group(1)] = _literal(named.group(2))
        elif given and any(NAMED_ARG.match(p) for p in _split_args(text)[:i]):
            raise ValueError("a positional argument after a named one")
        elif i < len(params):
            given[params[i]["name"]] = _literal(part)
        else:
            raise ValueError(f"takes {len(params)} arguments")
    return given


def _value_node(value: Any) -> exp.Expression:
    if value is None:
        return exp.Null()
    if isinstance(value, bool):
        return exp.Boolean(this=value)
    if isinstance(value, datetime.date):
        return exp.cast(exp.Literal.string(value.isoformat()), "DATE")
    if isinstance(value, (int, float)):
        return exp.Literal.number(value)
    return exp.Literal.string(str(value))


def _bind(sql: str, values: dict[str, Any], dialect: str) -> str:
    """A Databricks template with each ``:name`` replaced by its value, rendered in ``dialect``."""

    def bound(node: exp.Expression) -> exp.Expression:
        return _value_node(values[node.name]) if isinstance(node, exp.Placeholder) and node.name in values else node

    return sqlglot.parse_one(sql, read="databricks").transform(bound).sql(dialect=dialect, comments=False)


def _qualified(expression: str, alias: str, dialect: str) -> str:
    """A definition's expression, its unqualified columns qualified with ``alias``, in parentheses."""
    node = sqlglot.parse_one(expression, read="databricks")
    for column in node.find_all(exp.Column):
        if not column.table:
            column.set("table", exp.to_identifier(alias))
    return f"({node.sql(dialect=dialect, comments=False)})"

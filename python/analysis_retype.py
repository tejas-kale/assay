"""The retype check (specs/slices/slice-10.md, slice 10d): SQL that writes out a trusted piece's logic by hand.

A ``-- retype: <piece>: <reason>`` comment silences that piece.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple

import sqlglot
from sqlglot import exp

from analysis_include import Pieces, expand_with
from analysis_sqlread import arg, bind_dummies, last_statement

RETYPE_SILENCE = re.compile(r"--\s*retype:\s*([\w.:]+)\s*:", re.IGNORECASE)

KeyPairs = set[frozenset[tuple[str, str]]]


def retype(sql: str, dialect: str, root: Path | str, pieces: Pieces | None = None) -> dict[str, list[str]]:
    """Warnings for SQL that writes out a trusted definition's or block's logic by hand.

    ``sql`` is the SQL as written with its includes removed (``expand``'s ``retype_sql``).
    """
    statement, _ = last_statement(sql, dialect, False)
    if statement is None:
        return {"warnings": []}
    pieces = pieces or Pieces(Path(root))
    check = _Check(_definitions(pieces), _blocks(pieces), {name.lower() for name in RETYPE_SILENCE.findall(sql)})
    for select in statement.find_all(exp.Select):
        check.select(select)
    return {"warnings": list(check.warnings.values())}


class _Definition(NamedTuple):
    full: str
    short: str
    table: list[str]
    kind: str
    expression: exp.Expression


class _Block(NamedTuple):
    name: str
    calc: dict[str, Any]
    tables: list[list[str]]
    pairs: KeyPairs
    said: str


def _definitions(pieces: Pieces) -> list[_Definition]:
    """The definitions whose SQL parses."""
    found = []
    for full in pieces.definitions:
        table, _, short = full.partition(":")
        try:
            item = pieces.item(full)
            expression = sqlglot.parse_one(str(item["sql"]).strip(), read="databricks")
        except Exception:
            continue  # A definition that does not read is not checked.
        found.append(_Definition(full, short, table.lower().split("."), item["kind"], expression))
    return found


def _blocks(pieces: Pieces) -> list[_Block]:
    """The blocks, approved in the app, that join tables."""
    found = []
    for name, calc in pieces.calcs.items():
        if "block" not in calc or calc.get("dirty"):
            continue
        try:
            body = expand_with(calc["sql"], "databricks", pieces, inside_block=name)
            shape = None if body.get("errors") else _block_shape(body["sql"])
        except Exception:
            shape = None
        if shape:
            found.append(_Block(name, calc, *shape))
    return found


class _Select(NamedTuple):
    """What one SELECT reads: its tables by alias, its conditions' conjuncts, its projections."""

    select: exp.Select
    sources: dict[str, list[str]]
    conjuncts: list[exp.Expression]
    projections: list[exp.Expression]


@dataclass
class _Check:
    definitions: list[_Definition]
    blocks: list[_Block]
    silenced: set[str]
    warnings: dict[str, str] = field(default_factory=dict)

    def select(self, select: exp.Select) -> None:
        ons = [join.args.get("on") for join in select.args.get("joins") or []]
        clauses = [arg(select, "where"), arg(select, "having")]
        conditions = [node.this if node is not None else None for node in clauses] + ons
        conjuncts = [c for node in conditions for c in _conjuncts(node)]
        projections = [projection.unalias() for projection in select.expressions]
        here = _Select(select, _read_tables(select), conjuncts, projections)
        for definition in self.definitions:
            self._definition(definition, here)
        for block in self.blocks:
            self._block(block, here)

    def _definition(self, definition: _Definition, here: _Select) -> None:
        full, short = definition.full, definition.short
        if full.lower() in self.silenced or short.lower() in self.silenced or full in self.warnings:
            return
        only = len(here.sources) == 1
        for alias, parts in here.sources.items():
            if _same_table(parts, definition.table) and _retyped(definition, here, alias, only):
                said = definition.expression.sql(dialect="databricks")
                self.warnings[full] = f"retypes {full} ({said}): include {{{{ {short}({alias}) }}}}"
                return

    def _block(self, block: _Block, here: _Select) -> None:
        if block.name.lower() in self.silenced or block.name in self.warnings:
            return
        tables_read = all(any(_same_table(parts, table) for parts in here.sources.values()) for table in block.tables)
        if tables_read and block.pairs <= _key_pairs(here.select, here.sources):
            args = ", ".join(f"{param['name']} => ..." for param in block.calc["parameters"])
            name = block.name
            self.warnings[name] = f"retypes block {name} ({block.said}): include {{{{ {name}({args}) }}}} as a CTE"


def _retyped(definition: _Definition, here: _Select, alias: str, only: bool) -> bool:
    """Whether the SELECT writes out ``definition`` on table ``alias``: all of a filter's conjuncts, or a metric."""
    if definition.kind == "filter":
        wanted = {_norm(c) for c in _conjuncts(definition.expression)}
        have = {_norm(c) for c in here.conjuncts if _on_alias(c, alias, only)}
        return wanted <= have
    return any(_on_alias(p, alias, only) and _norm(p) == _norm(definition.expression) for p in here.projections)


def _parts(table: exp.Table) -> list[str]:
    return [part.name.lower() for part in table.parts]


def _same_table(written: list[str], full: list[str]) -> bool:
    """A table as written matches a full name when the parts it gives agree (``sessions`` matches ``c.s.sessions``)."""
    k = min(len(written), len(full))
    return k > 0 and written[-k:] == full[-k:]


def _read_tables(select: exp.Select) -> dict[str, list[str]]:
    """The tables a SELECT reads directly (FROM and JOINs), by alias (or name) lower-cased: their name parts."""
    found: dict[str, list[str]] = {}
    from_ = arg(select, "from")
    for node in [from_.this if from_ is not None else None, *[join.this for join in select.args.get("joins") or []]]:
        if isinstance(node, exp.Table) and node.name:
            found[(node.alias_or_name or node.name).lower()] = _parts(node)
    return found


def _sorted_sides(node: exp.Expression) -> exp.Expression:
    """``=`` and ``<>`` with their sides in a fixed order."""
    if not isinstance(node, (exp.EQ, exp.NEQ)):
        return node
    sides = (node.this, node.expression)
    return node.__class__(this=min(sides, key=_sql), expression=max(sides, key=_sql))


def _sql(node: exp.Expression) -> str:
    return node.sql()


def _norm(node: exp.Expression) -> str:
    """An expression without column qualifiers, in a canonical form: ``=`` and ``<>`` sides sorted."""
    node = node.copy()
    for column in node.find_all(exp.Column):
        column.set("table", None)
    return node.transform(_sorted_sides).sql(dialect="databricks", comments=False).lower()


def _conjuncts(node: exp.Expression | None) -> list[exp.Expression]:
    if node is None:
        return []
    node = node.unnest() if isinstance(node, exp.Paren) else node
    if isinstance(node, exp.And):
        return [*_conjuncts(node.this), *_conjuncts(node.expression)]
    return [node]


def _on_alias(node: exp.Expression, alias: str, only_source: bool) -> bool:
    """Whether every column in ``node`` is qualified with ``alias``, or unqualified when the SELECT has one source."""
    columns = list(node.find_all(exp.Column))
    return bool(columns) and all(_on(column, alias, only_source) for column in columns)


def _on(column: exp.Column, alias: str, only_source: bool) -> bool:
    return column.table.lower() == alias or (not column.table and only_source)


def _key_pairs(select: exp.Select, sources: dict[str, list[str]]) -> KeyPairs:
    """The equality pairs of a SELECT's JOIN conditions, each between columns of two of its tables: by table name."""
    pairs: KeyPairs = set()
    for join in select.args.get("joins") or []:
        for conjunct in _conjuncts(join.args.get("on")):
            if _is_column_equality(conjunct):
                left, right = conjunct.this, conjunct.expression
                a, b = sources.get(left.table.lower()), sources.get(right.table.lower())
                if a and b and a != b:
                    pairs.add(frozenset({(a[-1], left.name.lower()), (b[-1], right.name.lower())}))
    return pairs


def _is_column_equality(node: exp.Expression) -> bool:
    return isinstance(node, exp.EQ) and isinstance(node.this, exp.Column) and isinstance(node.expression, exp.Column)


def _block_shape(sql: str) -> tuple[list[list[str]], KeyPairs, str] | None:
    """A block's join: its tables, its key pairs and how to say it; None when its SQL joins nothing."""
    statement = sqlglot.parse_one(bind_dummies(sql), read="databricks")
    for select in statement.find_all(exp.Select):
        sources = _read_tables(select)
        pairs = _key_pairs(select, sources)
        if len(sources) > 1 and pairs:
            names = sorted({parts[-1] for parts in sources.values()})
            keys = sorted({column for pair in pairs for _, column in pair})
            return list(sources.values()), pairs, f"the join of {' and '.join(names)} on {', '.join(keys)}"
    return None

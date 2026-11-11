"""How the SQL modules read a query: its ``-- grain:`` and ``-- join:`` lines, its CTEs and final SELECT, its output
columns, and the last statement of a text (docs/slice-9.md).

sqlglot attaches a comment to the token after it: the CTE's alias, the JOIN, the SELECT.
"""

from __future__ import annotations

import re
from typing import Any

import sqlglot
from sqlglot import exp

DIALECTS = ("databricks", "postgres")
GRAIN = re.compile(r"^\s*grain\s*:\s*(.*?)\s*$", re.IGNORECASE)
JOIN = re.compile(r"^\s*join\s*:\s*(.*?)\s*$", re.IGNORECASE)
JOIN_FORM = re.compile(r"^(1:1|1:many|many:1|many:many)\s+on\s+(\S.*)$", re.IGNORECASE)
PLACEHOLDER = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")


def check_dialect(dialect: str) -> None:
    if dialect not in DIALECTS:
        raise ValueError(f"dialect {dialect!r} is not one of {', '.join(DIALECTS)}")


def comment(comments: list[str] | None, pattern: re.Pattern[str]) -> str | None:
    """What follows ``grain:`` or ``join:`` in the last such comment, or None when there is none."""
    found = None
    for each in comments or []:
        for line in each.splitlines():
            match = pattern.match(line)
            if match:
                found = match.group(1)
    return found


def column_name(identifier: str) -> str:
    """A column as written in a grain line, compared like an output column: unquoted, unqualified, lower case."""
    return identifier.strip().strip("`\"").rsplit(".", 1)[-1].strip("`\"").lower()


def grain_columns(text: str) -> list[str]:
    """The columns a grain line's text names, as compared."""
    return [column_name(part) for part in text.split(",") if part.strip()]


def grain(comments: list[str]) -> list[str] | None:
    """The columns on a ``-- grain:`` line, ``[]`` for ``none``; None when there is no line."""
    text = comment(comments, GRAIN)
    if text is None:
        return None
    columns = grain_columns(text)
    return [] if columns == ["none"] else columns


def join_line(join: exp.Join) -> tuple[str, list[str]] | None:
    """A join's declared cardinality (``1:many``, lower case) and keys; None when its line is missing or malformed."""
    text = comment(join.comments, JOIN)
    match = JOIN_FORM.match(text) if text is not None else None
    if match is None:
        return None
    return match.group(1).lower(), [key.strip() for key in match.group(2).split(",") if key.strip()]


def first_select(query: exp.Expression) -> exp.Expression:
    while isinstance(query, exp.SetOperation):
        query = query.left
    return query


def outputs(query: exp.Expression, alias: exp.TableAlias | None = None) -> list[str] | None:
    """The output columns of a query (or the CTE's column list); None when a ``*`` hides them."""
    if alias is not None and alias.columns:
        return [column.name.lower() for column in alias.columns]
    query = first_select(query)
    if isinstance(query, exp.Subquery):
        query = query.this
    if not isinstance(query, exp.Select):
        return None
    names = []
    for selected in query.expressions:
        if isinstance(selected, exp.Star) or (isinstance(selected, exp.Column) and isinstance(selected.this, exp.Star)):
            return None
        names.append(selected.alias_or_name.lower())
    return names


def cte_outputs(cte: exp.CTE) -> list[str] | None:
    return outputs(cte.this, cte.args.get("alias"))


def cte_comments(cte: exp.CTE) -> list[str]:
    alias = cte.args.get("alias")
    return [*(alias.comments or [] if alias is not None else []), *(cte.comments or [])]


def top_ctes(statement: exp.Expression) -> list[exp.CTE]:
    """The statement's CTEs, not those nested inside another CTE."""
    return [cte for cte in statement.find_all(exp.CTE) if cte.find_ancestor(exp.CTE) is None]


def final_query(statement: exp.Expression) -> exp.Expression:
    """The query a statement's final SELECT belongs to: the ``AS`` query of ``CREATE VIEW`` or ``CREATE TABLE ... AS``,
    else the statement itself. A comment above ``CREATE`` is not above the final SELECT."""
    if isinstance(statement, exp.Create) and isinstance(statement.expression, exp.Query):
        return statement.expression
    return statement


def final_comments(statement: exp.Expression) -> list[str]:
    final = first_select(statement)
    return [*(statement.comments or []), *((final.comments or []) if final is not statement else [])]


def arg(node: exp.Expression, name: str) -> Any:
    """``node.args[name]``; sqlglot 30 spells ``with`` and ``from`` as ``with_`` and ``from_``."""
    return node.args.get(f"{name}_") or node.args.get(name)


def set_arg(node: exp.Expression, name: str, value: Any) -> None:
    node.set(f"{name}_" if f"{name}_" in type(node).arg_types else name, value)


def bind_dummies(sql: str) -> str:
    """A SQL template with each ``:name`` parameter replaced by NULL, so it parses as a plain statement."""
    return PLACEHOLDER.sub("NULL", sql)


def last_statement(sql: str, dialect: str, template: bool) -> tuple[exp.Expression | None, int]:
    """The last statement of ``sql`` and how many there are; ``template`` binds ``:name`` parameters first."""
    check_dialect(dialect)
    statements = [s for s in sqlglot.parse(bind_dummies(sql) if template else sql, read=dialect) if s is not None]
    return (statements[-1] if statements else None), len(statements)


def statement_note(count: int) -> dict[str, str]:
    return {"note": f"{count} statements; the lineage is of the last one."} if count > 1 else {}

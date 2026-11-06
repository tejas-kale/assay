"""Assay's SQL rules: what makes Claude's multi-CTE and JOIN queries readable (docs/slice-9.md).

Assay's MCP server runs it with venv-assay's python before a ``sql`` tool call runs:

    python -m analysis_sql lint <databricks|postgres> [<sql-file>]   (the SQL on stdin without a file)

It prints ``{"errors": [...], "warnings": [...]}``, or ``{"error": ...}`` when the SQL does not parse.

The comments it reads, each on the line directly above what it describes:

    -- grain: <col>[, <col>...]        above ``<name> AS (`` and above the final SELECT; ``none`` for one row
    -- join: <1:1|1:many|many:1|many:many> on <key>[, <key>...]   above each JOIN, left side first

sqlglot attaches a comment to the token after it: the CTE's alias, the JOIN, the SELECT.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import sqlglot
from sqlglot import exp

DIALECTS = ("databricks", "postgres")
GRAIN = re.compile(r"^\s*grain\s*:\s*(.*?)\s*$", re.IGNORECASE)
JOIN = re.compile(r"^\s*join\s*:\s*(.*?)\s*$", re.IGNORECASE)
JOIN_FORM = re.compile(r"^(1:1|1:many|many:1|many:many)\s+on\s+(\S.*)$", re.IGNORECASE)
CRYPTIC = re.compile(r"^(step|cte|tmp|temp|t|q|sub)_?\d*$", re.IGNORECASE)
MIN_NAME = 4
JOIN_SHAPE = '"-- join: <1:1|1:many|many:1|many:many> on <key>[, <key>...]"'
FANNING = (exp.Sum, exp.Count, exp.Avg)


def _comment(comments: list[str] | None, pattern: re.Pattern[str]) -> str | None:
    """What follows ``grain:`` or ``join:`` in the last such comment, or None when there is none."""
    found = None
    for comment in comments or []:
        for line in comment.splitlines():
            match = pattern.match(line)
            if match:
                found = match.group(1)
    return found


def _name(identifier: str) -> str:
    """A column as written in a grain line, compared like an output column: unquoted, unqualified, lower case."""
    return identifier.strip().strip("`\"").rsplit(".", 1)[-1].strip("`\"").lower()


def _outputs(query: exp.Expression, alias: exp.TableAlias | None = None) -> list[str] | None:
    """The output columns of a query (or the CTE's column list); None when a ``*`` hides them."""
    if alias is not None and alias.columns:
        return [column.name.lower() for column in alias.columns]
    while isinstance(query, exp.SetOperation):
        query = query.left
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


def _check_grain(where: str, comments: list[str] | None, outputs: list[str] | None, errors: list[str]) -> None:
    grain = _comment(comments, GRAIN)
    if grain is None:
        errors.append(f'{where}: no "-- grain:" line above it.')
        return
    columns = [_name(part) for part in grain.split(",") if part.strip()]
    if not columns:
        errors.append(f'{where}: the "-- grain:" line names no column; give the columns that identify one row, or none.')
        return
    if columns == ["none"] or outputs is None:
        return
    missing = [column for column in columns if column not in outputs]
    if missing:
        listed = ", ".join(outputs) or "none"
        noun = "is not one of its output columns" if len(missing) == 1 else "are not among its output columns"
        errors.append(f"{where}: grain {', '.join(missing)} {noun} ({listed}).")


def _first_select(query: exp.Expression) -> exp.Expression:
    while isinstance(query, exp.SetOperation):
        query = query.left
    return query


def _owner(node: exp.Expression) -> str:
    """Who a node belongs to, as a reply names it: ``CTE <name>`` or ``Final SELECT``."""
    cte = node.find_ancestor(exp.CTE)
    return f"CTE {cte.alias}" if cte is not None else "Final SELECT"


def _scope(node: exp.Expression) -> exp.Select | None:
    """The SELECT a node is part of: its nearest SELECT ancestor."""
    return node.find_ancestor(exp.Select)


def _line(node: exp.Expression) -> int | None:
    for each in (node, *node.find_all(exp.Identifier)):
        line = each.meta.get("line") if hasattr(each, "meta") else None
        if line:
            return int(line)
    return None


def _join_label(join: exp.Join) -> str:
    target = join.this
    if isinstance(target, exp.Table):
        what = target.name
    elif isinstance(target, exp.Subquery):
        what = f"(subquery) {target.alias}".strip()
    else:
        what = target.sql()[:40]
    line = _line(target)
    return f"{_owner(join)}, JOIN {what}{f' (line {line})' if line else ''}"


def _declared(join: exp.Join) -> str | None:
    """A join's declared cardinality (``1:many``), lower case; None when its line is missing or malformed."""
    text = _comment(join.comments, JOIN)
    if text is None:
        return None
    match = JOIN_FORM.match(text)
    return match.group(1).lower() if match else None


def _aggregates_here(select: exp.Select) -> list[exp.Expression]:
    """The SUM, COUNT and AVG calls in a SELECT's own columns and HAVING, not in its subqueries."""
    found = []
    for part in (*select.expressions, select.args.get("having")):
        if part is None:
            continue
        for node in part.find_all(*FANNING):
            if _scope(node) is select:
                found.append(node)
    return found


def _does_aggregate(select: exp.Select) -> bool:
    if select.args.get("group"):
        return True
    for part in select.expressions:
        for node in part.find_all(exp.AggFunc):
            if _scope(node) is select and not node.find_ancestor(exp.Window):
                return True
    return False


def lint_statement(statement: exp.Expression, errors: list[str], warnings: list[str]) -> None:
    ctes = list(statement.find_all(exp.CTE))
    joins = list(statement.find_all(exp.Join))
    if not ctes and not joins:
        return

    for cte in ctes:
        where = f"CTE {cte.alias}"
        alias = cte.args.get("alias")
        comments = [*(alias.comments or [] if alias is not None else []), *(cte.comments or [])]
        _check_grain(where, comments, _outputs(cte.this, alias), errors)
        name = cte.alias
        if len(name) < MIN_NAME:
            errors.append(f"{where}: name too short; say what it holds.")
        elif CRYPTIC.match(name):
            errors.append(f"{where}: name says what it does, not what it holds; say what it holds.")

    final = _first_select(statement)
    _check_grain("Final SELECT", [*(statement.comments or []), *((final.comments or []) if final is not statement else [])], _outputs(statement), errors)

    for join in joins:
        label = _join_label(join)
        text = _comment(join.comments, JOIN)
        is_cross = (join.args.get("kind") or "").upper() == "CROSS"
        if text is None:
            hint = ' For a CROSS JOIN: "-- join: many:many on none".' if is_cross else ""
            errors.append(f'{label}: no "-- join:" line above it.{hint}')
        elif not JOIN_FORM.match(text):
            errors.append(f'{label}: the "-- join:" line reads "{text}"; write {JOIN_SHAPE}.')

    for subquery in statement.find_all(exp.Subquery):
        parent = subquery.parent
        if isinstance(parent, (exp.From, exp.Join)):
            clause = "FROM" if isinstance(parent, exp.From) else "JOIN"
            line = _line(subquery)
            errors.append(f"{_owner(subquery)}: subquery in {clause}{f' (line {line})' if line else ''}; make it a CTE.")

    for cte in ctes:
        body = cte.this
        if not isinstance(body, exp.Select):
            continue
        jobs = [job for job, does in (("filters", bool(body.args.get("where"))), ("joins", bool(body.args.get("joins"))), ("aggregates", _does_aggregate(body))) if does]
        if len(jobs) >= 2:
            warnings.append(f"CTE {cte.alias}: {' and '.join(jobs)}; do one of filter, join, aggregate per CTE.")

    for select in statement.find_all(exp.Select):
        fanning = [join for join in select.args.get("joins") or [] if _declared(join) in ("1:many", "many:many")]
        if not fanning:
            continue
        functions = sorted({type(node).__name__.upper() for node in _aggregates_here(select)})
        if not functions:
            continue
        for join in fanning:
            warnings.append(f"{_join_label(join)}: a {_declared(join)} join feeds {', '.join(functions)} in the same SELECT; aggregate before joining.")


def lint(sql: str, dialect: str = "databricks") -> dict[str, list[str]]:
    """The SQL rules' errors (the query must not run) and warnings (it runs; the reply lists them).

    A plain one-table query, with no CTE and no JOIN, has neither. Raises when ``sql`` does not parse.
    """
    if dialect not in DIALECTS:
        raise ValueError(f"dialect {dialect!r} is not one of {', '.join(DIALECTS)}")
    errors: list[str] = []
    warnings: list[str] = []
    for statement in sqlglot.parse(sql, read=dialect):
        if statement is not None:
            lint_statement(statement, errors, warnings)
    return {"errors": errors, "warnings": warnings}


PLACEHOLDER = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")


def bind_dummies(sql: str) -> str:
    """A SQL template with each ``:name`` parameter replaced by NULL, so it parses as a plain statement."""
    return PLACEHOLDER.sub("NULL", sql)


USAGE = "usage: python -m analysis_sql lint <databricks|postgres> [<sql-file>]   (SQL on stdin without a file)"


def main(argv: list[str]) -> int:
    command, *args = argv or [""]
    try:
        if command == "lint" and len(args) in (1, 2):
            sql = Path(args[1]).read_text() if len(args) == 2 else sys.stdin.read()
            answer: dict[str, Any] = lint(sql, args[0])
        else:
            answer = {"error": f"{USAGE}\ngot: {argv}"}
    except sqlglot.errors.ParseError as error:
        answer = {"error": f"the SQL does not parse: {str(error).splitlines()[0]}"}
    except Exception as error:  # The server reads every failure from stdout.
        answer = {"error": f"{type(error).__name__}: {error}"}
    print(json.dumps(answer))
    return 1 if "error" in answer else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""Assay's SQL rules: what makes Claude's multi-CTE and JOIN queries readable (specs/slices/slice-9.md).

The comments they read, each on the line directly above what it describes:

    -- grain: <col>[, <col>...]        above ``<name> AS (`` and above the final SELECT; ``none`` for one row
    -- join: <1:1|1:many|many:1|many:many> on <key>[, <key>...]   above each JOIN, left side first
"""

from __future__ import annotations

import re

import sqlglot
from sqlglot import exp

from analysis_sqlread import (
    GRAIN,
    JOIN,
    JOIN_FORM,
    check_dialect,
    comment,
    cte_comments,
    cte_outputs,
    final_comments,
    final_query,
    grain_columns,
    join_line,
    outputs,
)

CRYPTIC = re.compile(r"^(step|cte|tmp|temp|t|q|sub)_?\d*$", re.IGNORECASE)
MIN_NAME = 4
JOIN_SHAPE = '"-- join: <1:1|1:many|many:1|many:many> on <key>[, <key>...]"'
FANNING = (exp.Sum, exp.Count, exp.Avg)


def lint(sql: str, dialect: str = "databricks") -> dict[str, list[str]]:
    """The SQL rules' errors (the query must not run) and warnings (it runs; the reply lists them).

    A plain one-table query, with no CTE and no JOIN, has neither. Raises when ``sql`` does not parse.
    """
    check_dialect(dialect)
    errors: list[str] = []
    warnings: list[str] = []
    for statement in sqlglot.parse(sql, read=dialect):
        if statement is not None:
            lint_statement(statement, errors, warnings)
    return {"errors": errors, "warnings": warnings}


def lint_statement(statement: exp.Expression, errors: list[str], warnings: list[str]) -> None:
    ctes = list(statement.find_all(exp.CTE))
    joins = list(statement.find_all(exp.Join))
    if not ctes and not joins:
        return
    for cte in ctes:
        errors.extend(_cte_errors(cte))
    final = final_query(statement)
    errors.extend(_grain_errors("Final SELECT", final_comments(final), outputs(final)))
    for join in joins:
        errors.extend(_join_errors(join))
    errors.extend(_subquery_errors(statement))
    warnings.extend(_job_warnings(ctes))
    warnings.extend(_fanning_warnings(statement))


def _grain_errors(where: str, comments: list[str] | None, columns_out: list[str] | None) -> list[str]:
    text = comment(comments, GRAIN)
    if text is None:
        return [f'{where}: no "-- grain:" line above it.']
    columns = grain_columns(text)
    if not columns:
        return [f'{where}: the "-- grain:" line names no column; give the columns that identify one row, or none.']
    if columns == ["none"] or columns_out is None:
        return []
    missing = [column for column in columns if column not in columns_out]
    if not missing:
        return []
    listed = ", ".join(columns_out) or "none"
    noun = "is not one of its output columns" if len(missing) == 1 else "are not among its output columns"
    return [f"{where}: grain {', '.join(missing)} {noun} ({listed})."]


def _cte_errors(cte: exp.CTE) -> list[str]:
    """A CTE's grain line, and a name that says what it holds."""
    where = f"CTE {cte.alias}"
    errors = _grain_errors(where, cte_comments(cte), cte_outputs(cte))
    if len(cte.alias) < MIN_NAME:
        errors.append(f"{where}: name too short; say what it holds.")
    elif CRYPTIC.match(cte.alias):
        errors.append(f"{where}: name says what it does, not what it holds; say what it holds.")
    return errors


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


def _at_line(node: exp.Expression) -> str:
    """`` (line N)`` for a node whose line is known, else nothing."""
    line = _line(node)
    return f" (line {line})" if line else ""


def _join_label(join: exp.Join) -> str:
    target = join.this
    if isinstance(target, exp.Table):
        what = target.name
    elif isinstance(target, exp.Subquery):
        what = f"(subquery) {target.alias}".strip()
    else:
        what = target.sql()[:40]
    return f"{_owner(join)}, JOIN {what}{_at_line(target)}"


def _join_errors(join: exp.Join) -> list[str]:
    """A missing or malformed ``-- join:`` line."""
    label = _join_label(join)
    text = comment(join.comments, JOIN)
    if text is None:
        is_cross = (join.args.get("kind") or "").upper() == "CROSS"
        hint = ' For a CROSS JOIN: "-- join: many:many on none".' if is_cross else ""
        return [f'{label}: no "-- join:" line above it.{hint}']
    if not JOIN_FORM.match(text):
        return [f'{label}: the "-- join:" line reads "{text}"; write {JOIN_SHAPE}.']
    return []


def _subquery_errors(statement: exp.Expression) -> list[str]:
    """A subquery in FROM or JOIN, which should be a CTE."""
    errors = []
    for subquery in statement.find_all(exp.Subquery):
        parent = subquery.parent
        if isinstance(parent, (exp.From, exp.Join)):
            clause = "FROM" if isinstance(parent, exp.From) else "JOIN"
            errors.append(f"{_owner(subquery)}: subquery in {clause}{_at_line(subquery)}; make it a CTE.")
    return errors


def _does_aggregate(select: exp.Select) -> bool:
    if select.args.get("group"):
        return True
    for part in select.expressions:
        for node in part.find_all(exp.AggFunc):
            if _scope(node) is select and not node.find_ancestor(exp.Window):
                return True
    return False


def _job_warnings(ctes: list[exp.CTE]) -> list[str]:
    """A CTE that does more than one of filter, join and aggregate."""
    warnings = []
    for cte in ctes:
        body = cte.this
        if not isinstance(body, exp.Select):
            continue
        does = {
            "filters": bool(body.args.get("where")),
            "joins": bool(body.args.get("joins")),
            "aggregates": _does_aggregate(body),
        }
        jobs = [job for job, done in does.items() if done]
        if len(jobs) > 1:
            warnings.append(f"CTE {cte.alias}: {' and '.join(jobs)}; do one of filter, join, aggregate per CTE.")
    return warnings


def _aggregates_here(select: exp.Select) -> list[exp.Expression]:
    """The SUM, COUNT and AVG calls in a SELECT's own columns and HAVING, not in its subqueries."""
    found = []
    for part in (*select.expressions, select.args.get("having")):
        if part is None:
            continue
        found.extend(node for node in part.find_all(*FANNING) if _scope(node) is select)
    return found


def _declared(join: exp.Join) -> str | None:
    """A join's declared cardinality (``1:many``), lower case; None when its line is missing or malformed."""
    line = join_line(join)
    return line[0] if line else None


def _fanning_warnings(statement: exp.Expression) -> list[str]:
    """A join to the many side that feeds SUM, COUNT or AVG in the same SELECT."""
    warnings = []
    for select in statement.find_all(exp.Select):
        fanning = [join for join in select.args.get("joins") or [] if _declared(join) in ("1:many", "many:many")]
        if not fanning:
            continue
        functions = sorted({type(node).__name__.upper() for node in _aggregates_here(select)})
        if not functions:
            continue
        for join in fanning:
            label, declared, fed = _join_label(join), _declared(join), ", ".join(functions)
            warnings.append(f"{label}: a {declared} join feeds {fed} in the same SELECT; aggregate before joining.")
    return warnings

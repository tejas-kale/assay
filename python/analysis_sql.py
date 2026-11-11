"""Assay's SQL rules: what makes Claude's multi-CTE and JOIN queries readable (docs/slice-9.md).

Assay's MCP server runs it with Assay's venv's python before a ``sql`` tool call runs:

    python -m analysis_sql lint <databricks|postgres> [<sql-file>]   (the SQL on stdin without a file)

It prints ``{"errors": [...], "warnings": [...]}``, or ``{"error": ...}`` when the SQL does not parse.

    python -m analysis_sql lineage <databricks|postgres> [--template] [<sql-file>]

prints the query's CTE graph, ``{"nodes": [...], "edges": [...]}`` (``--template`` binds ``:name`` parameters first).

    python -m analysis_sql steps <databricks|postgres> [--template] [<sql-file>]

prints ``{"lineage": ..., "steps": [...]}``: the lineage plus, for each CTE and the final SELECT, the preview and
counts queries the server runs (slice 9c).

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

import analysis_calc
import analysis_dictionary
import analysis_library

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


def _cte_comments(cte: exp.CTE) -> list[str]:
    alias = cte.args.get("alias")
    return [*(alias.comments or [] if alias is not None else []), *(cte.comments or [])]


def _final_query(statement: exp.Expression) -> exp.Expression:
    """The query a statement's final SELECT belongs to: the ``AS`` query of ``CREATE VIEW`` or ``CREATE TABLE ... AS``,
    else the statement itself. A comment above ``CREATE`` is not above the final SELECT."""
    if isinstance(statement, exp.Create) and isinstance(statement.expression, exp.Query):
        return statement.expression
    return statement


def _final_comments(statement: exp.Expression) -> list[str]:
    final = _first_select(statement)
    return [*(statement.comments or []), *((final.comments or []) if final is not statement else [])]


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
        _check_grain(where, _cte_comments(cte), _outputs(cte.this, cte.args.get("alias")), errors)
        name = cte.alias
        if len(name) < MIN_NAME:
            errors.append(f"{where}: name too short; say what it holds.")
        elif CRYPTIC.match(name):
            errors.append(f"{where}: name says what it does, not what it holds; say what it holds.")

    final = _final_query(statement)
    _check_grain("Final SELECT", _final_comments(final), _outputs(final), errors)

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


def _grain(comments: list[str]) -> list[str] | None:
    """The columns on a ``-- grain:`` line, ``[]`` for ``none``; None when there is no line."""
    text = _comment(comments, GRAIN)
    if text is None:
        return None
    columns = [_name(part) for part in text.split(",") if part.strip()]
    return [] if columns == ["none"] else columns


def _join_edge(table: exp.Table) -> dict[str, Any] | None:
    """The ``join`` of an edge: the declared cardinality and keys, ``{}`` for a JOIN without a good line; None for FROM."""
    join = table.parent
    if not isinstance(join, exp.Join) or join.this is not table:
        return None
    text = _comment(join.comments, JOIN)
    match = JOIN_FORM.match(text) if text is not None else None
    if match is None:
        return {}
    keys = [key.strip() for key in match.group(2).split(",") if key.strip()]
    return {"cardinality": match.group(1).lower(), "keys": keys}


def lineage_statement(statement: exp.Expression, blocks: dict[str, str] | None = None) -> dict[str, Any]:
    """The CTE graph. A CTE in ``blocks`` (lower-cased CTE name -> block) holds an included block (docs/slice-10.md): its
    node says which, and the tables inside it are not drawn."""
    blocks = blocks or {}
    ctes = [cte for cte in statement.find_all(exp.CTE) if cte.find_ancestor(exp.CTE) is None]
    cte_names = {cte.alias.lower() for cte in ctes}
    final_id = "final_select" if "final" in cte_names else "final"
    readers: list[tuple[str, exp.Expression | None]] = [(cte.alias.lower(), cte) for cte in ctes] + [(final_id, None)]

    tables: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    for target, cte in readers:
        if target in blocks and cte is not None:
            continue
        for table in (cte.this if cte is not None else statement).find_all(exp.Table):
            # The final SELECT reads what is outside the CTEs.
            if not table.name or (cte is None and table.find_ancestor(exp.CTE) is not None):
                continue
            name = ".".join(part.name for part in table.parts)
            source = name.lower()
            if source not in cte_names or len(table.parts) > 1:
                tables.setdefault(source, {"id": source, "kind": "table", "name": name})
            edge: dict[str, Any] = {"from": source, "to": target}
            join = _join_edge(table)
            if join is not None:
                edge["join"] = join
            # Each JOIN is its own edge; a source read twice outside a JOIN is one.
            if join is not None or edge not in edges:
                edges.append(edge)

    nodes: list[dict[str, Any]] = list(tables.values())
    for cte in ctes:
        node: dict[str, Any] = {"id": cte.alias.lower(), "kind": "cte", "name": cte.alias}
        if cte.alias.lower() in blocks:
            node["block"] = blocks[cte.alias.lower()]
        grain = _grain(_cte_comments(cte))
        if grain is not None:
            node["grain"] = grain
        nodes.append(node)
    final: dict[str, Any] = {"id": final_id, "kind": "final", "name": "Final SELECT"}
    grain = _grain(_final_comments(_final_query(statement)))
    if grain is not None:
        final["grain"] = grain
    nodes.append(final)
    return {"nodes": nodes, "edges": edges}


def _last_statement(sql: str, dialect: str, template: bool) -> tuple[exp.Expression | None, int]:
    """The last statement of ``sql`` and how many there are; ``template`` binds ``:name`` parameters first."""
    if dialect not in DIALECTS:
        raise ValueError(f"dialect {dialect!r} is not one of {', '.join(DIALECTS)}")
    statements = [s for s in sqlglot.parse(bind_dummies(sql) if template else sql, read=dialect) if s is not None]
    return (statements[-1] if statements else None), len(statements)


def _statement_note(count: int) -> dict[str, str]:
    return {"note": f"{count} statements; the lineage is of the last one."} if count > 1 else {}


def lineage(sql: str, dialect: str = "databricks", template: bool = False, blocks: dict[str, str] | None = None) -> dict[str, Any]:
    """The CTE graph of the last statement in ``sql`` (docs/slice-9.md, "analysis_sql lineage").

    ``template`` binds ``:name`` parameters first. Raises when ``sql`` does not parse.
    """
    statement, count = _last_statement(sql, dialect, template)
    if statement is None:
        return {"nodes": [], "edges": [], "note": "There is no statement."}
    return {**lineage_statement(statement, blocks), **_statement_note(count)}


# ---------------------------------------------------------------------------
# Steps (slice 9c): the queries that run each CTE on its own, and count what it holds.

PREVIEW_ROWS = 50
FINAL = "final"
ASSAY_FINAL = "assay_final"


def _arg(node: exp.Expression, name: str) -> Any:
    """``node.args[name]``; sqlglot 30 spells ``with`` and ``from`` as ``with_`` and ``from_``."""
    return node.args.get(f"{name}_") or node.args.get(name)


def _set_arg(node: exp.Expression, name: str, value: Any) -> None:
    node.set(f"{name}_" if f"{name}_" in type(node).arg_types else name, value)


def _ident(name: str) -> exp.Identifier:
    return exp.to_identifier(name)


def _table(name: str) -> exp.Table:
    return exp.Table(this=_ident(name))


def _with(query: exp.Expression, ctes: list[exp.Expression]) -> exp.Expression:
    if ctes:
        _set_arg(query, "with", exp.With(expressions=ctes))
    return query


def _reads(node: exp.Expression, known: set[str]) -> set[str]:
    """The CTEs (of ``known``) a query reads by their bare name."""
    return {table.name.lower() for table in node.find_all(exp.Table) if len(table.parts) == 1 and table.name.lower() in known}


def _needed(ctes: list[exp.CTE], roots: set[str]) -> list[exp.CTE]:
    """The CTEs ``roots`` read, transitively, in written order (SQL requires a CTE be written before its readers)."""
    by_name = {cte.alias.lower(): cte for cte in ctes}
    wanted: set[str] = set()
    todo = list(roots)
    while todo:
        name = todo.pop()
        if name not in wanted:
            wanted.add(name)
            todo.extend(_reads(by_name[name].this, set(by_name)))
    return [cte for cte in ctes if cte.alias.lower() in wanted]


def _count(relation: exp.Table, columns: list[str] | None = None) -> exp.Subquery:
    """``(SELECT COUNT(*) FROM relation)``; with ``columns``, over their distinct tuples (a NULL counts as a value)."""
    source: exp.Expression = relation.copy()
    if columns:
        distinct = exp.select(*[exp.column(_ident(column)) for column in columns]).distinct().from_(relation.copy())
        source = exp.Subquery(this=distinct, alias=exp.TableAlias(this=_ident("assay_d")))
    return exp.Subquery(this=exp.select(exp.Count(this=exp.Star())).from_(source))


def _sources(select: exp.Select) -> list[exp.Expression]:
    """The FROM source and each JOIN's source, in order."""
    first = _arg(select, "from")
    return [*([first.this] if first is not None else []), *[join.this for join in select.args.get("joins") or []]]


def _equalities(condition: exp.Expression | None) -> list[exp.EQ] | None:
    """The column equalities an ``ON`` is an AND of; None when it is anything else."""
    while isinstance(condition, exp.Paren):
        condition = condition.this
    if isinstance(condition, exp.And):
        left, right = _equalities(condition.left), _equalities(condition.right)
        return None if left is None or right is None else left + right
    if isinstance(condition, exp.EQ) and isinstance(condition.left, exp.Column) and isinstance(condition.right, exp.Column):
        return [condition]
    return None


def _sides(select: exp.Select, index: int) -> tuple[dict[str, Any], None] | tuple[None, str]:
    """What join ``index`` of ``select`` compares: both relations and their key columns, or why it cannot be checked."""
    join = select.args["joins"][index]
    target = join.this
    if (join.args.get("kind") or "").upper() == "CROSS":
        return None, "a CROSS JOIN has no keys"
    if not isinstance(target, exp.Table):
        return None, "the joined source is a subquery"
    sources = _sources(select)
    if join.args.get("using"):
        if index != 0 or not isinstance(sources[0], exp.Table):
            return None, "USING is read only when the SELECT has one FROM source and no earlier join"
        keys = [identifier.name for identifier in join.args["using"]]
        return {"left": sources[0], "right": target, "left_keys": keys, "right_keys": keys}, None
    equalities = _equalities(join.args.get("on"))
    if not equalities:
        return None, "the ON is not an AND of column equalities"
    mine = target.alias_or_name.lower()
    by_name = {source.alias_or_name.lower(): source for source in sources}
    left: exp.Expression | None = None
    left_keys: list[str] = []
    right_keys: list[str] = []
    for equality in equalities:
        here = [side for side in (equality.left, equality.right) if side.table.lower() == mine]
        there = [side for side in (equality.left, equality.right) if side.table.lower() != mine]
        if len(here) != 1 or len(there) != 1:
            return None, "each equality must compare the joined source with one other source"
        other = by_name.get(there[0].table.lower()) if there[0].table else None
        if not isinstance(other, exp.Table):
            return None, "a column in the ON is not qualified by a table or alias of this SELECT"
        if left is not None and other is not left:
            return None, "the ON reads more than two sources"
        left = other
        left_keys.append(there[0].name)
        right_keys.append(here[0].name)
    assert left is not None
    return {"left": left, "right": target, "left_keys": left_keys, "right_keys": right_keys}, None


def _bare(table: exp.Table) -> exp.Table:
    """The relation as named in FROM / JOIN, without its alias."""
    bare = table.copy()
    bare.set("alias", None)
    return bare


def _joins(select: exp.Expression) -> tuple[list[dict[str, Any]], list[tuple[str, exp.Expression]]]:
    """A step's own joins as the plan lists them, and the counts columns for those that can be checked."""
    listed: list[dict[str, Any]] = []
    columns: list[tuple[str, exp.Expression]] = []
    if not isinstance(select, exp.Select):
        return listed, columns
    for index, join in enumerate(select.args.get("joins") or []):
        j = index + 1
        text = _comment(join.comments, JOIN)
        match = JOIN_FORM.match(text) if text is not None else None
        target = join.this
        entry: dict[str, Any] = {"j": j, "source": target.name if isinstance(target, exp.Table) else (target.alias or "(subquery)")}
        if match is not None:
            entry["declared"] = match.group(1).lower()
            entry["keys"] = [key.strip() for key in match.group(2).split(",") if key.strip()]
        sides, reason = _sides(select, index)
        if match is None:
            sides, reason = None, 'there is no well-formed "-- join:" line'
        if sides is None:
            entry.update({"checked": False, "reason": reason})
        else:
            left, right = _bare(sides["left"]), _bare(sides["right"])
            columns += [
                (f"assay_j{j}_left_rows", _count(left)),
                (f"assay_j{j}_left_keys", _count(left, sides["left_keys"])),
                (f"assay_j{j}_right_rows", _count(right)),
                (f"assay_j{j}_right_keys", _count(right, sides["right_keys"])),
            ]
        listed.append(entry)
    return listed, columns


def steps(sql: str, dialect: str = "databricks", template: bool = False, blocks: dict[str, str] | None = None) -> dict[str, Any]:
    """The lineage and the step queries of the last statement in ``sql`` (docs/slice-9.md, "analysis_sql steps").

    One step per CTE in written order, then ``final``. Each has a ``counts`` query and, but for ``final``, a ``preview``.
    ``steps`` is ``[]`` with a ``note`` when there is nothing to step through. Raises when ``sql`` does not parse.
    """
    statement, count = _last_statement(sql, dialect, template)
    if statement is None:
        return {"lineage": {"nodes": [], "edges": []}, "steps": [], "note": "There is no statement."}
    blocks = blocks or {}
    graph = {**lineage_statement(statement, blocks), **_statement_note(count)}
    ctes = [cte for cte in statement.find_all(exp.CTE) if cte.find_ancestor(exp.CTE) is None]
    with_ = _arg(statement, "with")
    if not ctes:
        return {"lineage": graph, "steps": [], "note": "There is no CTE: nothing to step through."}
    if with_ is not None and with_.args.get("recursive"):
        return {"lineage": graph, "steps": [], "note": "A recursive CTE is not stepped."}

    final = statement.copy()
    _set_arg(final, "with", None)
    known = {cte.alias.lower() for cte in ctes}
    nodes = {node["id"]: i for i, node in enumerate(graph["nodes"])}
    render = lambda query: query.sql(dialect=dialect, comments=False)  # Comments are for readers of the query, not the warehouse.

    planned: list[dict[str, Any]] = []
    for k, cte in enumerate([*ctes, None], start=1):
        is_final = cte is None
        if is_final:
            name, node_id, relation = FINAL, graph["nodes"][-1]["id"], _table(ASSAY_FINAL)
            grain, outputs, own = _grain(_final_comments(statement)), _outputs(statement), final
            needed: list[exp.Expression] = [*_needed(ctes, _reads(final, known))]
            # The final SELECT is counted as one more CTE.
            with_ctes = [item.copy() for item in needed] + [exp.CTE(this=final.copy(), alias=exp.TableAlias(this=_ident(ASSAY_FINAL)))]
            if isinstance(final, exp.SetOperation):
                grain = None  # Set operations count rows only.
        else:
            name, node_id, relation = cte.alias, cte.alias.lower(), _table(cte.alias)
            grain, outputs, own = _grain(_cte_comments(cte)), _outputs(cte.this, cte.args.get("alias")), cte.this
            needed = [*_needed(ctes, {name.lower()})]
            with_ctes = [item.copy() for item in needed]
        # An included block is one step: its joins were checked once, in the Trust tab.
        block = None if is_final else blocks.get(cte.alias.lower())
        listed, join_columns = ([], []) if block else _joins(own)
        selected: list[tuple[str, exp.Expression]] = [("assay_rows", _count(relation))]
        # `grain: none` is judged on assay_rows; a `*` output hides the columns to count.
        if grain and outputs is not None:
            selected.append(("assay_grain_rows", _count(relation, grain)))
        selected += join_columns
        counts = _with(exp.select(*[exp.alias_(value, column) for column, value in selected]), with_ctes)
        step: dict[str, Any] = {"k": k, "name": name, "node": nodes[node_id], "preview": None, "counts": render(counts)}
        if not is_final:
            step["preview"] = render(_with(exp.select("*").from_(relation.copy()).limit(PREVIEW_ROWS), [item.copy() for item in needed]))
        if grain is not None:
            step["grain"] = grain
        if block:
            step["block"] = block
        if listed:
            step["joins"] = listed
        planned.append(step)
    answer: dict[str, Any] = {"lineage": graph, "steps": planned}
    if isinstance(final, exp.SetOperation):
        answer["note"] = "The final SELECT is a set operation: its step counts rows only."
    return answer


# ---------------------------------------------------------------------------
# Include by name (docs/slice-10.md, slice 10c): Claude's SQL names trusted blocks and dictionary definitions, and
# they are expanded here before the query runs.
#
#   sessions AS ({{ client_entry_sessions(start => '2026-11-01', end => '2026-11-08') }})   a block, as a CTE body
#   WHERE {{ client_entry(s) }}                                                              a definition, on alias s

INCLUDE = re.compile(r"\{\{\s*(?P<name>[A-Za-z_][\w.]*(?::[A-Za-z_]\w*)?)\s*\((?P<args>[^{}]*)\)\s*\}\}")
CTE_OPEN = re.compile(r"(?P<cte>[A-Za-z_]\w*)\s+AS\s*\(\s*$", re.IGNORECASE)
NAMED_ARG = re.compile(r"^\s*([A-Za-z_]\w*)\s*=>\s*(.*?)\s*$", re.DOTALL)


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
    if len(text) >= 2 and text[0] == text[-1] == "'":
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
    import datetime

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
    statement = sqlglot.parse_one(sql, read="databricks")
    statement = statement.transform(lambda node: _value_node(values[node.name]) if isinstance(node, exp.Placeholder) and node.name in values else node)
    return statement.sql(dialect=dialect, comments=False)


def _qualified(expression: str, alias: str, dialect: str) -> str:
    """A definition's expression, its unqualified columns qualified with ``alias``, in parentheses."""
    node = sqlglot.parse_one(expression, read="databricks")
    for column in node.find_all(exp.Column):
        if not column.table:
            column.set("table", exp.to_identifier(alias))
    return f"({node.sql(dialect=dialect, comments=False)})"


class Pieces:
    """The trusted pieces under a root: blocks and other templates by name, definitions by full and short name."""

    def __init__(self, root: Path) -> None:
        self.root = root
        listed = analysis_library.list_calculations(root)
        self.calcs = {calc["name"]: calc for calc in listed["calculations"] if calc["kind"] != "definition"}
        self.definitions = {calc["name"]: calc for calc in listed["calculations"] if calc["kind"] == "definition"}
        self.short: dict[str, list[str]] = {}
        for full in self.definitions:
            self.short.setdefault(full.partition(":")[2], []).append(full)

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


def expand(sql: str, dialect: str, root: Path | str, pieces: Pieces | None = None, inside_block: str | None = None) -> dict[str, Any]:
    """``sql`` with its included blocks and definitions expanded (docs/slice-10.md, "Expansion").

    ``sql`` runs; ``lint_sql`` is the SQL as written with each block body replaced by ``SELECT <its columns> FROM
    <block>`` and each definition expanded; ``built_from`` lists the pieces in order of first use, ``blocks`` which CTE
    holds which block. ``{"errors": [...]}`` when a piece is unknown, misused or not trusted as committed.
    """
    if dialect not in DIALECTS:
        raise ValueError(f"dialect {dialect!r} is not one of {', '.join(DIALECTS)}")
    if "{{" not in sql:
        return {"sql": sql, "lint_sql": sql, "retype_sql": sql, "built_from": [], "blocks": []}
    pieces = pieces or Pieces(Path(root))
    errors: list[str] = []
    built: dict[str, dict[str, Any]] = {}
    blocks: list[dict[str, str]] = []
    out: list[str] = []
    lint_out: list[str] = []
    retype_out: list[str] = []
    at = 0

    def use(name: str, kind: str, calc: dict[str, Any]) -> bool:
        if calc.get("dirty"):
            errors.append(f"{name} differs from its last commit, or was never committed: it is not trusted until the user approves it again")
            return False
        built.setdefault(name, {"name": name, "kind": kind, "commit": calc.get("commit", "")})
        return True

    for match in INCLUDE.finditer(sql):
        name, args = match.group("name"), match.group("args")
        written = match.group(0)
        out.append(sql[at : match.start()])
        lint_out.append(sql[at : match.start()])
        retype_out.append(sql[at : match.start()])
        at = match.end()
        replacement = lint_replacement = written
        # The retype check reads an included definition as TRUE, so the include itself is never flagged.
        retype_replacement = "TRUE"
        full, problem = pieces.definition(name)
        calc = pieces.calcs.get(name)
        if problem:
            errors.append(f"{written}: {problem}.")
        elif full:
            alias = args.strip()
            if not re.fullmatch(r"[A-Za-z_]\w*", alias):
                errors.append(f"{written}: a definition takes the alias of its table, e.g. {{{{ {name}(s) }}}}.")
            elif use(full, "definition", pieces.definitions[full]):
                replacement = lint_replacement = _qualified(pieces.expression(full), alias, dialect)
        elif calc and "block" in calc:
            opened = CTE_OPEN.search(sql[: match.start()])
            if inside_block:
                errors.append(f"{written}: block {inside_block} includes block {name}; a block includes definitions only.")
            elif not opened or not re.match(r"\s*\)", sql[match.end() :]):
                errors.append(f"{written}: a block is the whole body of a CTE, e.g. sessions AS ({written}).")
            else:
                try:
                    values = analysis_calc.convert(calc["parameters"], _block_args(calc["parameters"], args))
                except Exception as error:
                    errors.append(f"{written}: {error}; {name}({', '.join(p['name'] + ('' if p['required'] else '?') + ': ' + p['type'] for p in calc['parameters'])}).")
                    values = None
                if values is not None and use(name, "block", calc):
                    body = expand(calc["sql"], "databricks", root, pieces, inside_block=name)
                    if body.get("errors"):
                        errors.extend(body["errors"])
                    else:
                        for piece in body["built_from"]:
                            built.setdefault(piece["name"], piece)
                        replacement = _bind(body["sql"], values, dialect)
                        lint_replacement = retype_replacement = f"SELECT {', '.join(calc['block']['columns'])} FROM {name}"
                        blocks.append({"cte": opened.group("cte"), "name": name})
        elif calc:
            errors.append(f"{written}: {name} is a calculation, not a block or definition: run it whole with the trusted tool, or propose a block.")
        else:
            errors.append(f"{written}: no trusted block or definition named {name}.")
        out.append(replacement)
        lint_out.append(lint_replacement)
        retype_out.append(retype_replacement)
    out.append(sql[at:])
    lint_out.append(sql[at:])
    retype_out.append(sql[at:])
    if errors:
        return {"errors": errors}
    return {"sql": "".join(out), "lint_sql": "".join(lint_out), "retype_sql": "".join(retype_out), "built_from": list(built.values()), "blocks": blocks}


# ---------------------------------------------------------------------------
# The retype check (docs/slice-10.md, slice 10d): SQL that writes out a trusted piece's logic by hand.

RETYPE_SILENCE = re.compile(r"--\s*retype:\s*([\w.:]+)\s*:", re.IGNORECASE)


def _parts(table: exp.Table) -> list[str]:
    return [part.name.lower() for part in table.parts]


def _same_table(written: list[str], full: list[str]) -> bool:
    """A table as written matches a full name when the parts it gives agree (``sessions`` matches ``c.s.sessions``)."""
    k = min(len(written), len(full))
    return k > 0 and written[-k:] == full[-k:]


def _read_tables(select: exp.Select) -> dict[str, list[str]]:
    """The tables a SELECT reads directly (FROM and JOINs), by alias (or name) lower-cased: their name parts."""
    found: dict[str, list[str]] = {}
    from_ = _arg(select, "from")
    for node in [from_.this if from_ is not None else None, *[join.this for join in select.args.get("joins") or []]]:
        if isinstance(node, exp.Table) and node.name:
            found[(node.alias_or_name or node.name).lower()] = _parts(node)
    return found


def _norm(node: exp.Expression) -> str:
    """An expression without column qualifiers, in a canonical form: ``=`` and ``<>`` sides sorted."""
    node = node.copy()
    for column in node.find_all(exp.Column):
        column.set("table", None)
    node = node.transform(lambda n: n.__class__(this=min(n.this, n.expression, key=lambda e: e.sql()), expression=max(n.this, n.expression, key=lambda e: e.sql())) if isinstance(n, (exp.EQ, exp.NEQ)) else n)
    return node.sql(dialect="databricks", comments=False).lower()


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
    return bool(columns) and all(column.table.lower() == alias or (not column.table and only_source) for column in columns)


def _key_pairs(select: exp.Select, sources: dict[str, list[str]]) -> set[frozenset[tuple[str, str]]]:
    """The equality pairs of a SELECT's JOIN conditions, each between columns of two of its tables: by table name."""
    pairs: set[frozenset[tuple[str, str]]] = set()
    for join in select.args.get("joins") or []:
        for conjunct in _conjuncts(join.args.get("on")):
            if isinstance(conjunct, exp.EQ) and isinstance(conjunct.this, exp.Column) and isinstance(conjunct.expression, exp.Column):
                left, right = conjunct.this, conjunct.expression
                a, b = sources.get(left.table.lower()), sources.get(right.table.lower())
                if a and b and a != b:
                    pairs.add(frozenset({(a[-1], left.name.lower()), (b[-1], right.name.lower())}))
    return pairs


def _block_shape(sql: str) -> tuple[list[list[str]], set[frozenset[tuple[str, str]]], str] | None:
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


def retype(sql: str, dialect: str, root: Path | str, pieces: Pieces | None = None) -> dict[str, list[str]]:
    """Warnings for SQL that writes out a trusted definition's or block's logic by hand (docs/slice-10.md).

    ``sql`` is the SQL as written with its includes removed (``expand``'s ``retype_sql``). A ``-- retype: <piece>:
    <reason>`` comment silences that piece.
    """
    statement, _ = _last_statement(sql, dialect, False)
    if statement is None:
        return {"warnings": []}
    pieces = pieces or Pieces(Path(root))
    silenced = {name.lower() for name in RETYPE_SILENCE.findall(sql)}
    warnings: dict[str, str] = {}

    definitions = []
    for full in pieces.definitions:
        table, _, short = full.partition(":")
        try:
            item = pieces.item(full)
            expression = sqlglot.parse_one(str(item["sql"]).strip(), read="databricks")
        except Exception:
            continue
        kind = item["kind"]
        definitions.append((full, short, table.lower().split("."), kind, expression))
    blocks = []
    for name, calc in pieces.calcs.items():
        if "block" not in calc or calc.get("dirty"):
            continue
        try:
            body = expand(calc["sql"], "databricks", pieces.root, pieces, inside_block=name)
            shape = None if body.get("errors") else _block_shape(body["sql"])
        except Exception:
            shape = None
        if shape:
            blocks.append((name, calc, *shape))

    for select in statement.find_all(exp.Select):
        sources = _read_tables(select)
        conditions = [_arg(select, "where"), _arg(select, "having"), *[join.args.get("on") for join in select.args.get("joins") or []]]
        conjuncts = [c for node in conditions for c in _conjuncts(node.this if isinstance(node, (exp.Where, exp.Having)) else node)]
        projections = [projection.unalias() for projection in select.expressions]
        for full, short, table, kind, expression in definitions:
            if full.lower() in silenced or short.lower() in silenced or full in warnings:
                continue
            for alias, parts in sources.items():
                if not _same_table(parts, table):
                    continue
                only = len(sources) == 1
                if kind == "filter":
                    wanted = {_norm(c) for c in _conjuncts(expression)}
                    have = {_norm(c) for c in conjuncts if _on_alias(c, alias, only)}
                    hit = wanted <= have
                else:
                    hit = any(_on_alias(p, alias, only) and _norm(p) == _norm(expression) for p in projections)
                if hit:
                    said = expression.sql(dialect="databricks")
                    warnings[full] = f"retypes {full} ({said}): include {{{{ {short}({alias}) }}}}"
                    break
        for name, calc, tables, pairs, said in blocks:
            if name.lower() in silenced or name in warnings:
                continue
            if all(any(_same_table(parts, table) for parts in sources.values()) for table in tables) and pairs <= _key_pairs(select, sources):
                args = ", ".join(f"{param['name']} => ..." for param in calc["parameters"])
                warnings[name] = f"retypes block {name} ({said}): include {{{{ {name}({args}) }}}} as a CTE"
    return {"warnings": list(warnings.values())}


PLACEHOLDER = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")


def bind_dummies(sql: str) -> str:
    """A SQL template with each ``:name`` parameter replaced by NULL, so it parses as a plain statement."""
    return PLACEHOLDER.sub("NULL", sql)


USAGE = (
    "usage: python -m analysis_sql lint <databricks|postgres> [<sql-file>]   (SQL on stdin without a file)\n"
    "       python -m analysis_sql lineage <databricks|postgres> [--template] [<sql-file>]\n"
    "       python -m analysis_sql steps <databricks|postgres> [--template] [--blocks cte=block,...] [<sql-file>]\n"
    "       python -m analysis_sql expand <databricks|postgres> <root>   (SQL on stdin)\n"
    "       python -m analysis_sql retype <databricks|postgres> <root>   (SQL on stdin)"
)


def _plain_args(args: list[str]) -> list[str]:
    """The arguments without ``--template`` and ``--blocks <value>``."""
    plain, skip = [], False
    for arg in args:
        if skip:
            skip = False
        elif arg == "--blocks":
            skip = True
        elif arg != "--template":
            plain.append(arg)
    return plain


def _blocks_arg(args: list[str]) -> dict[str, str]:
    """``--blocks sessions=client_entry_sessions,...`` as ``{cte (lower case): block}``."""
    if "--blocks" not in args or args.index("--blocks") + 1 >= len(args):
        return {}
    pairs = [pair.partition("=") for pair in args[args.index("--blocks") + 1].split(",") if pair]
    return {cte.strip().lower(): block.strip() for cte, _, block in pairs if block}


def main(argv: list[str]) -> int:
    command, *args = argv or [""]
    try:
        if command == "lint" and len(args) in (1, 2):
            sql = Path(args[1]).read_text() if len(args) == 2 else sys.stdin.read()
            answer: dict[str, Any] = lint(sql, args[0])
        elif command == "expand" and len(args) == 2:
            answer = expand(sys.stdin.read(), args[0], Path(args[1]))
        elif command == "retype" and len(args) == 2:
            answer = retype(sys.stdin.read(), args[0], Path(args[1]))
        elif command in ("lineage", "steps") and 1 <= len(_plain_args(args)) <= 2:
            template = "--template" in args
            blocks = _blocks_arg(args)
            args = _plain_args(args)
            sql = Path(args[1]).read_text() if len(args) == 2 else sys.stdin.read()
            answer = (lineage if command == "lineage" else steps)(sql, args[0], template, blocks)
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

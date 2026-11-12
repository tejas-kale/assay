"""A query's lineage: the graph of its CTEs, the tables they read and its final SELECT (specs/slices/slice-9.md,
"analysis_sql lineage")."""

from __future__ import annotations

from typing import Any

from sqlglot import exp

from analysis_sqlread import (
    cte_comments,
    final_comments,
    final_query,
    grain,
    join_line,
    last_statement,
    statement_note,
    top_ctes,
)


def lineage(
    sql: str, dialect: str = "databricks", template: bool = False, blocks: dict[str, str] | None = None,
) -> dict[str, Any]:
    """The CTE graph of the last statement in ``sql``.

    ``template`` binds ``:name`` parameters first. Raises when ``sql`` does not parse.
    """
    statement, count = last_statement(sql, dialect, template)
    if statement is None:
        return {"nodes": [], "edges": [], "note": "There is no statement."}
    return {**lineage_statement(statement, blocks), **statement_note(count)}


def lineage_statement(statement: exp.Expression, blocks: dict[str, str] | None = None) -> dict[str, Any]:
    """The CTE graph. A CTE in ``blocks`` (lower-cased CTE name -> block) holds an included block
    (specs/slices/slice-10.md): its node says which, and the tables inside it are not drawn."""
    blocks = blocks or {}
    ctes = top_ctes(statement)
    cte_names = {cte.alias.lower() for cte in ctes}
    final_id = "final_select" if "final" in cte_names else "final"
    tables, edges = _reads(statement, ctes, final_id, blocks)
    nodes: list[dict[str, Any]] = [*tables.values(), *(_cte_node(cte, blocks) for cte in ctes)]
    final: dict[str, Any] = {"id": final_id, "kind": "final", "name": "Final SELECT"}
    found = grain(final_comments(final_query(statement)))
    if found is not None:
        final["grain"] = found
    nodes.append(final)
    return {"nodes": nodes, "edges": edges}


def _reads(
    statement: exp.Expression, ctes: list[exp.CTE], final_id: str, blocks: dict[str, str],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """The tables the query reads, by id, and an edge for each read: each JOIN is its own edge."""
    cte_names = {cte.alias.lower() for cte in ctes}
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
            # A source read twice outside a JOIN is one edge.
            if join is not None or edge not in edges:
                edges.append(edge)
    return tables, edges


def _join_edge(table: exp.Table) -> dict[str, Any] | None:
    """The ``join`` of an edge: the declared cardinality and keys, ``{}`` for a JOIN without a good line; None for
    FROM."""
    join = table.parent
    if not isinstance(join, exp.Join) or join.this is not table:
        return None
    line = join_line(join)
    if line is None:
        return {}
    return {"cardinality": line[0], "keys": line[1]}


def _cte_node(cte: exp.CTE, blocks: dict[str, str]) -> dict[str, Any]:
    node: dict[str, Any] = {"id": cte.alias.lower(), "kind": "cte", "name": cte.alias}
    if cte.alias.lower() in blocks:
        node["block"] = blocks[cte.alias.lower()]
    found = grain(cte_comments(cte))
    if found is not None:
        node["grain"] = found
    return node

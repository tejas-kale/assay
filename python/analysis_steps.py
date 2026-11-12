"""A query's steps (specs/slices/slice-9.md, slice 9c, "analysis_sql steps"): the queries that run each CTE on its own
and count what it holds, and what each of its joins matches."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlglot import exp

from analysis_lineage import lineage_statement
from analysis_sqlread import (
    arg,
    cte_comments,
    cte_outputs,
    final_comments,
    grain,
    join_line,
    last_statement,
    outputs,
    set_arg,
    statement_note,
    top_ctes,
)

PREVIEW_ROWS = 50
FINAL = "final"
ASSAY_FINAL = "assay_final"


def steps(
    sql: str, dialect: str = "databricks", template: bool = False, blocks: dict[str, str] | None = None,
) -> dict[str, Any]:
    """The lineage and the step queries of the last statement in ``sql``.

    One step per CTE in written order, then ``final``. Each has a ``counts`` query and, but for ``final``, a
    ``preview``. ``steps`` is ``[]`` with a ``note`` when there is nothing to step through. Raises when ``sql`` does
    not parse.
    """
    statement, count = last_statement(sql, dialect, template)
    if statement is None:
        return {"lineage": {"nodes": [], "edges": []}, "steps": [], "note": "There is no statement."}
    blocks = blocks or {}
    graph = {**lineage_statement(statement, blocks), **statement_note(count)}
    ctes = top_ctes(statement)
    with_ = arg(statement, "with")
    if not ctes:
        return {"lineage": graph, "steps": [], "note": "There is no CTE: nothing to step through."}
    if with_ is not None and with_.args.get("recursive"):
        return {"lineage": graph, "steps": [], "note": "A recursive CTE is not stepped."}
    plan = _Plan(statement, graph, blocks, dialect)
    planned = [plan.step(k, cte) for k, cte in enumerate([*ctes, None], start=1)]
    answer: dict[str, Any] = {"lineage": graph, "steps": planned}
    if isinstance(plan.final, exp.SetOperation):
        answer["note"] = "The final SELECT is a set operation: its step counts rows only."
    return answer


@dataclass(frozen=True)
class _Target:
    """What one step runs: a CTE, or the final SELECT counted as one more CTE."""

    name: str
    node_id: str
    relation: exp.Table
    grain: list[str] | None
    outputs: list[str] | None
    own: exp.Expression
    needed: list[exp.CTE]
    with_ctes: list[exp.Expression]


class _Plan:
    """The steps of one statement."""

    def __init__(self, statement: exp.Expression, graph: dict[str, Any], blocks: dict[str, str], dialect: str) -> None:
        self.statement = statement
        self.ctes = top_ctes(statement)
        self.graph = graph
        self.blocks = blocks
        self.dialect = dialect
        self.final = statement.copy()
        set_arg(self.final, "with", None)
        self.known = {cte.alias.lower() for cte in self.ctes}
        self.nodes = {node["id"]: i for i, node in enumerate(graph["nodes"])}

    def render(self, query: exp.Expression) -> str:
        # Comments are for readers of the query, not the warehouse.
        return query.sql(dialect=self.dialect, comments=False)

    def target(self, cte: exp.CTE | None) -> _Target:
        if cte is not None:
            needed = _needed(self.ctes, {cte.alias.lower()})
            return _Target(
                cte.alias, cte.alias.lower(), _table(cte.alias), grain(cte_comments(cte)), cte_outputs(cte), cte.this,
                needed, [item.copy() for item in needed],
            )
        needed = _needed(self.ctes, _reads(self.final, self.known))
        final_cte = exp.CTE(this=self.final.copy(), alias=exp.TableAlias(this=_ident(ASSAY_FINAL)))
        # Set operations count rows only.
        found = None if isinstance(self.final, exp.SetOperation) else grain(final_comments(self.statement))
        return _Target(
            FINAL, self.graph["nodes"][-1]["id"], _table(ASSAY_FINAL), found, outputs(self.statement), self.final,
            needed, [*(item.copy() for item in needed), final_cte],
        )

    def step(self, k: int, cte: exp.CTE | None) -> dict[str, Any]:
        at = self.target(cte)
        # An included block is one step: its joins were checked once, in the Trust tab.
        block = None if cte is None else self.blocks.get(cte.alias.lower())
        listed, join_columns = ([], []) if block else _joins(at.own)
        selected: list[tuple[str, exp.Expression]] = [("assay_rows", _count(at.relation))]
        # `grain: none` is judged on assay_rows; a `*` output hides the columns to count.
        if at.grain and at.outputs is not None:
            selected.append(("assay_grain_rows", _count(at.relation, at.grain)))
        selected += join_columns
        counts = _with(exp.select(*[exp.alias_(value, column) for column, value in selected]), at.with_ctes)
        node, rendered = self.nodes[at.node_id], self.render(counts)
        step: dict[str, Any] = {"k": k, "name": at.name, "node": node, "preview": None, "counts": rendered}
        if cte is not None:
            preview = exp.select("*").from_(at.relation.copy()).limit(PREVIEW_ROWS)
            step["preview"] = self.render(_with(preview, [item.copy() for item in at.needed]))
        if at.grain is not None:
            step["grain"] = at.grain
        if block:
            step["block"] = block
        if listed:
            step["joins"] = listed
        return step


def _ident(name: str) -> exp.Identifier:
    return exp.to_identifier(name)


def _table(name: str) -> exp.Table:
    return exp.Table(this=_ident(name))


def _with(query: exp.Expression, ctes: list[exp.Expression]) -> exp.Expression:
    """``query`` reading ``ctes``, which a step always has: its own CTE, or the final SELECT as one."""
    set_arg(query, "with", exp.With(expressions=ctes))
    return query


def _reads(node: exp.Expression, known: set[str]) -> set[str]:
    """The CTEs (of ``known``) a query reads by their bare name."""
    tables = node.find_all(exp.Table)
    return {table.name.lower() for table in tables if len(table.parts) == 1 and table.name.lower() in known}


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


# ---------------------------------------------------------------------------
# The joins of a step: which can be checked, and the counts that check them.


def _sources(select: exp.Select) -> list[exp.Expression]:
    """The FROM source and each JOIN's source, in order."""
    first = arg(select, "from")
    return [*([first.this] if first is not None else []), *[join.this for join in select.args.get("joins") or []]]


def _equalities(condition: exp.Expression | None) -> list[exp.EQ] | None:
    """The column equalities an ``ON`` is an AND of; None when it is anything else."""
    while isinstance(condition, exp.Paren):
        condition = condition.this
    if isinstance(condition, exp.And):
        left, right = _equalities(condition.left), _equalities(condition.right)
        return None if left is None or right is None else left + right
    if isinstance(condition, exp.EQ) and _of_columns(condition):
        return [condition]
    return None


def _of_columns(equality: exp.EQ) -> bool:
    """Whether both sides of an equality are columns."""
    return isinstance(equality.left, exp.Column) and isinstance(equality.right, exp.Column)


Sides = tuple[dict[str, Any], None] | tuple[None, str]


def _sides(select: exp.Select, index: int) -> Sides:
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
    return _on_sides(target, sources, equalities)


def _on_sides(target: exp.Table, sources: list[exp.Expression], equalities: list[exp.EQ]) -> Sides:
    """What an ``ON`` of equalities compares: ``target`` and one other source of the SELECT, key by key."""
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
        line = join_line(join)
        target = join.this
        source = target.name if isinstance(target, exp.Table) else (target.alias or "(subquery)")
        entry: dict[str, Any] = {"j": j, "source": source}
        if line is not None:
            entry["declared"], entry["keys"] = line
        sides, reason = _sides(select, index)
        if line is None:
            sides, reason = None, 'there is no well-formed "-- join:" line'
        if sides is None:
            entry.update({"checked": False, "reason": reason})
        else:
            columns += _join_counts(j, sides)
        listed.append(entry)
    return listed, columns


def _join_counts(j: int, sides: dict[str, Any]) -> list[tuple[str, exp.Expression]]:
    """The rows and the distinct keys on each side of join ``j``."""
    left, right = _bare(sides["left"]), _bare(sides["right"])
    return [
        (f"assay_j{j}_left_rows", _count(left)),
        (f"assay_j{j}_left_keys", _count(left, sides["left_keys"])),
        (f"assay_j{j}_right_rows", _count(right)),
        (f"assay_j{j}_right_keys", _count(right, sides["right_keys"])),
    ]

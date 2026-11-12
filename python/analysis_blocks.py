"""The Check's steps for a block (specs/slices/slice-10.md, slice 10b).

A block is a SQL template whose front matter has a ``block:`` contract, params -> grain -> columns. It joins tables at
a fixed grain, is about 30 lines at most, and is checked once against an independent rebuild, ``<name>.rebuild.sql``,
written from the contract alone.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import sqlglot
from sqlglot import exp

import analysis_runner
import analysis_sql
from analysis_calc import DIALECT, TrustError, cell, placeholders, plural

BLOCK_LINES = 30
REBUILDERS = ("codex", "copilot-opus")
REBUILT_BY = re.compile(r"^--\s*rebuilt by:\s*(\S+)\s*$", re.MULTILINE | re.IGNORECASE)
REBUILD_ROWS = 10

Step = Callable[[dict[str, Any]], None]
Rows = tuple[list[str], list[tuple[Any, ...]]]


@dataclass(frozen=True)
class Block:
    """A block under check: where it is, its contract and its declared parameters."""

    folder: Path
    name: str
    analysis: Path
    contract: dict[str, Any]
    parameters: list[dict[str, Any]]


def output_columns(sql: str) -> list[str]:
    """The output column names of a statement's final SELECT, in order; a TrustError for ``*`` or an unnamed column."""
    statements = [statement for statement in sqlglot.parse(sql, read=DIALECT) if statement is not None]
    if len(statements) != 1:
        raise TrustError(f"is {len(statements)} statements, not one")
    statement = statements[0]
    if not isinstance(statement, exp.Query):
        raise TrustError("is not a query")
    if any(_is_star(projection) for projection in statement.selects):
        raise TrustError("name every output column: no *")
    names = statement.named_selects
    if len(names) != len(statement.selects) or not all(names):
        raise TrustError("name every output column: give each expression an AS name")
    return [str(name) for name in names]


def _is_star(projection: exp.Expression) -> bool:
    return isinstance(projection, exp.Star) or (
        isinstance(projection, exp.Column) and isinstance(projection.this, exp.Star)
    )


def _lower(names: list[str]) -> list[str]:
    return [name.lower() for name in names]


def contract_text(params: list[dict[str, Any]], contract: dict[str, Any]) -> str:
    grain = ", ".join(contract["grain"]) or "one row"
    said = ", ".join(param["name"] for param in params) or "none"
    return f"params {said} -> grain {grain} -> {plural(len(contract['columns']), 'column')}"


def contract_step(sql: str, params: list[dict[str, Any]], contract: dict[str, Any], step: Step) -> bool:
    """The ``contract`` step: the SQL's output columns and grain line match the contract. Above 30 lines it warns."""
    try:
        _check_contract(sql, contract)
    except Exception as error:
        step({"step": "contract", "ok": False, "text": str(error)})
        return False
    text = contract_text(params, contract)
    lines = len(sql.strip().splitlines())
    if lines > BLOCK_LINES:
        text += f"\nwarning: {lines} lines; a block is about {BLOCK_LINES} at most"
    step({"step": "contract", "ok": True, "text": text})
    return True


def _check_contract(sql: str, contract: dict[str, Any]) -> None:
    columns = output_columns(sql)
    wanted = list(contract["columns"])
    if _lower(columns) != _lower(wanted):
        raise TrustError(f"the SQL returns {', '.join(columns)}; the contract says {', '.join(wanted)}")
    nodes = analysis_sql.lineage(sql, DIALECT, template=True).get("nodes", [])
    final = next((node for node in nodes if node.get("kind") == "final"), None)
    line = final.get("grain") if final else None
    if line is not None and _lower(line) != _lower(contract["grain"]):
        said = ", ".join(line) or "none"
        raise TrustError(
            f"the final SELECT's grain line says {said}; the contract says {', '.join(contract['grain']) or 'none'}"
        )


def grain_step(columns: list[str], rows: list[tuple[Any, ...]], grain: list[str], step: Step) -> bool:
    """The ``grain`` step on live rows: as many rows as distinct grain tuples (one row for grain ``[]``)."""
    if not grain:
        ok = len(rows) == 1
        text = f"grain none (one row): {plural(len(rows), 'row')}"
    else:
        at = [_lower(columns).index(column.lower()) for column in grain]
        distinct = len({tuple(row[i] for i in at) for row in rows})
        ok = distinct == len(rows)
        said = ", ".join(grain)
        text = (
            f"grain {said}: {plural(len(rows), 'row')}, {distinct} distinct"
            if ok
            else f"grain {said} has {plural(len(rows) - distinct, 'duplicate row')}"
        )
    step({"step": "grain", "ok": ok, "text": text})
    return ok


def rebuild_step(block: Block, values: dict[str, Any], found: Rows, step: Step) -> bool:
    """The ``rebuild`` step: ``<name>.rebuild.sql``, signed by who wrote it, run on the same arguments; its rows and the
    block's ``found`` rows compared as multisets, both ways."""
    wanted = list(block.contract["columns"])
    try:
        who, rebuilt = _run_rebuild(block, values, wanted)
    except Exception as error:
        text = str(error) if isinstance(error, TrustError) else f"{type(error).__name__}: {error}"
        step({"step": "rebuild", "ok": False, "text": text})
        return False
    mine, theirs = _multiset(wanted, found), _multiset(wanted, rebuilt)
    only_block, only_rebuild = mine - theirs, theirs - mine
    if not only_block and not only_rebuild:
        text = f"block and rebuild ({who}) agree: {plural(sum(mine.values()), 'row')}"
        step({"step": "rebuild", "ok": True, "text": text})
        return True
    counts = f"{plural(sum(only_block.values()), 'row')} only in the block, {sum(only_rebuild.values())}"
    lines = [f"{counts} only in the rebuild ({who})", ",".join(wanted)]
    lines += [f"block only:   {row}" for row in _sample(only_block)]
    lines += [f"rebuild only: {row}" for row in _sample(only_rebuild)]
    step({"step": "rebuild", "ok": False, "text": "\n".join(lines)})
    return False


def _run_rebuild(block: Block, values: dict[str, Any], wanted: list[str]) -> tuple[str, Rows]:
    """Who signed the rebuild, and its rows on ``values``; a TrustError when it is missing, unsigned or off contract."""
    path = block.folder / f"{block.name}.rebuild.sql"
    if not path.is_file():
        raise TrustError(
            f"no {path.name}: a rebuild written from the contract alone, by Codex (or an Opus model in Copilot)"
        )
    sql = path.read_text()
    signed = REBUILT_BY.search(sql)
    if not signed or signed.group(1).lower() not in REBUILDERS:
        raise TrustError(f"{path.name} has no '-- rebuilt by: {'|'.join(REBUILDERS)}' line")
    declared = {param["name"] for param in block.parameters}
    used = placeholders(sql)
    if not used <= declared:
        raise TrustError(f"{path.name} uses :{', :'.join(sorted(used - declared))}, which the block does not declare")
    given = {key: value for key, value in values.items() if key in used}
    columns, rows = analysis_runner.run_rows(sql, given, block.analysis)
    if sorted(_lower(columns)) != sorted(_lower(wanted)):
        raise TrustError(f"{path.name} returns {', '.join(columns)}; the contract says {', '.join(wanted)}")
    return signed.group(1).lower(), (columns, rows)


def _multiset(wanted: list[str], found: Rows) -> Counter[tuple[Any, ...]]:
    """The rows' values in the contract's column order, counted."""
    columns, rows = found
    at = [_lower(columns).index(column.lower()) for column in wanted]
    return Counter(tuple(row[i] for i in at) for row in rows)


def _shown(value: Any) -> str:
    return str(int(value)) if isinstance(value, float) and value.is_integer() else cell(value)


def _sample(found: Counter[tuple[Any, ...]]) -> list[str]:
    return [",".join(_shown(v) for v in row) for row in list(found.elements())[:REBUILD_ROWS]]

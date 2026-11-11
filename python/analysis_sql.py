"""Assay's SQL helper: the SQL rules, a query's lineage and steps, include by name and the retype check.

Assay's MCP server runs it with Assay's venv's python before a ``sql`` tool call runs:

    python -m analysis_sql lint <databricks|postgres> [<sql-file>]   (the SQL on stdin without a file)

It prints ``{"errors": [...], "warnings": [...]}``, or ``{"error": ...}`` when the SQL does not parse.

    python -m analysis_sql lineage <databricks|postgres> [--template] [<sql-file>]

prints the query's CTE graph, ``{"nodes": [...], "edges": [...]}`` (``--template`` binds ``:name`` parameters first).

    python -m analysis_sql steps <databricks|postgres> [--template] [<sql-file>]

prints ``{"lineage": ..., "steps": [...]}``: the lineage plus, for each CTE and the final SELECT, the preview and
counts queries the server runs (slice 9c). ``expand`` and ``retype`` read the SQL on stdin (docs/slice-10.md).

The modules behind it: ``analysis_sqlread`` (how a query is read: its grain and join lines, CTEs and outputs),
``analysis_lint`` (the rules), ``analysis_lineage``, ``analysis_steps``, ``analysis_include`` (``{{ piece(...) }}``)
and ``analysis_retype``. Other helpers import the names below from here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import sqlglot

from analysis_include import Pieces, expand
from analysis_lineage import lineage
from analysis_lint import lint
from analysis_retype import retype
from analysis_sqlread import bind_dummies
from analysis_steps import steps

__all__ = ["Pieces", "bind_dummies", "expand", "lineage", "lint", "main", "retype", "steps"]

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


def _read(files: list[str]) -> str:
    """The SQL in the one file named, or on stdin when none is."""
    return Path(files[0]).read_text() if files else sys.stdin.read()


def _answer(command: str, args: list[str]) -> dict[str, Any] | None:
    """What ``command`` prints for ``args``; None when they do not fit it."""
    match command, args, _plain_args(args):
        case "lint", [dialect, *files], _ if len(files) <= 1:
            return lint(_read(files), dialect)
        case "expand", [dialect, root], _:
            return expand(sys.stdin.read(), dialect, Path(root))
        case "retype", [dialect, root], _:
            return retype(sys.stdin.read(), dialect, Path(root))
        case ("lineage" | "steps"), _, [dialect, *files] if len(files) <= 1:
            run = lineage if command == "lineage" else steps
            return run(_read(files), dialect, "--template" in args, _blocks_arg(args))
    return None


def main(argv: list[str]) -> int:
    command, *args = argv or [""]
    try:
        answer = _answer(command, args) or {"error": f"{USAGE}\ngot: {argv}"}
    except sqlglot.errors.ParseError as error:
        answer = {"error": f"the SQL does not parse: {str(error).splitlines()[0]}"}
    except Exception as error:  # The server reads every failure from stdout.
        answer = {"error": f"{type(error).__name__}: {error}"}
    print(json.dumps(answer))
    return 1 if "error" in answer else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

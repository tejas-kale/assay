"""Assay's Python side of the data dictionary and trusted calculations: the command line.

Assay's MCP server (``src/server``) runs it with Assay's venv's python as ``python -m analysis_trust
<command> ...``; each command prints one JSON object on stdout. It parses SQL with sqlglot, reads the
YAML files in ``<notes-src>/dictionaries/`` and, for trusted calculations, ``<notes-src>/trusted/``.

    dictionary <notes-src> <sql-file>          the tables the SQL touches and their dictionary entries
    list <notes-src>                           the calculations and definitions, and which the app approved
    run <notes-src> <name> <args> <analysis>   runs one on the analysis's warehouse
    render <notes-src> <table:definition> <args>  the SQL a definition's run sends
    check <folder> <name> <analysis> [--stream]    what the Trust tab shows: form, transpile, tests, a live run
    check-entry <draft-file> <analysis> [--stream] what the Trust tab shows for a drafted dictionary entry

With ``--stream`` a check prints one JSON line per event (start, step, done) as it happens.

The work is done by the modules it calls: ``analysis_calc`` (a calculation's form and values), ``analysis_dictionary``
(entries and definitions), ``analysis_library`` (the listing), ``analysis_ledger`` (what the app approved),
``analysis_runner`` (runs on the warehouse), ``analysis_fixtures`` and ``analysis_pytest`` (the tests),
``analysis_blocks`` and ``analysis_review`` (the Check).
Layout and formats: the Assay README.
"""

from __future__ import annotations

import importlib
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from analysis_calc import TrustError
from analysis_dictionary import dictionary
from analysis_library import TRUSTED, list_calculations, require_trusted

USAGE = """usage: python -m analysis_trust <command> ...
  dictionary <notes-src> <sql-file>
  list <notes-src>
  run <notes-src> <name> <args-json> <analysis>
  render <notes-src> <table:definition> <args-json>
  check <folder> <name> <analysis> [--stream]
  check-entry <draft-file> <analysis> [--stream]"""

Emit = Callable[[dict[str, Any]], None]


def _heavy(module: str) -> Any:
    """A module that loads SQLAlchemy or DuckDB, imported only by the commands that use it: ``list`` and
    ``dictionary`` run on every prompt, and must not wait for either."""
    return importlib.import_module(module)


def __getattr__(name: str) -> Any:
    """``analysis_trust.fixture_engine``, which a Python calculation's own tests call (the propose-trusted skill shows
    it), loaded on first use for the same reason."""
    if name == "fixture_engine":
        return _heavy("analysis_fixtures").fixture_engine
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _arguments(text: str) -> dict[str, Any]:
    given = json.loads(text)
    if not isinstance(given, dict):
        raise TrustError("the arguments are not a JSON object")
    return given


def _dictionary(args: list[str], _: Emit | None) -> Any:
    return dictionary(Path(args[0]), Path(args[1]).read_text())


def _list(args: list[str], _: Emit | None) -> Any:
    return list_calculations(Path(args[0]))


def _run(args: list[str], _: Emit | None) -> Any:
    given = _arguments(args[2])
    source = require_trusted(Path(args[0]), args[1])
    return _heavy("analysis_runner").run_checked(Path(args[0]) / TRUSTED, source, given, Path(args[3]))


def _render(args: list[str], _: Emit | None) -> Any:
    given = _arguments(args[2])
    source = require_trusted(Path(args[0]), args[1])
    return {"sql": _heavy("analysis_runner").render(Path(args[0]), args[1], given, source)}


def _check(args: list[str], emit: Emit | None) -> Any:
    return _heavy("analysis_review").check(Path(args[0]), args[1], Path(args[2]), emit)


def _check_entry(args: list[str], emit: Emit | None) -> Any:
    return _heavy("analysis_review").check_entry(Path(args[0]), Path(args[1]), emit)


# Each command, and how many arguments it takes.
COMMANDS: dict[str, tuple[Callable[[list[str], Emit | None], Any], int]] = {
    "dictionary": (_dictionary, 2),
    "list": (_list, 1),
    "run": (_run, 4),
    "render": (_render, 3),
    "check": (_check, 3),
    "check-entry": (_check_entry, 2),
}
STREAMED = ("check", "check-entry")


def _command(command: str, args: list[str]) -> Callable[[list[str], Emit | None], Any] | None:
    """The command's function, when it is one and takes this many arguments."""
    function, count = COMMANDS.get(command, (None, -1))
    return function if len(args) == count else None


def stream_check(command: str, args: list[str]) -> int:
    """``check`` or ``check-entry`` with ``--stream``: one JSON line per event, flushed; the last is ``done``."""

    def emit(event: dict[str, Any]) -> None:
        print(json.dumps(event, default=str), flush=True)

    function = _command(command, args)
    try:
        answer = function(args, emit) if function else {"error": f"{USAGE}\ngot: {command} {args} --stream"}
    except Exception as error:
        answer = {"error": f"{type(error).__name__}: {error}"}
    emit({"event": "done", "answer": answer})
    return 1 if "error" in answer else 0


def main(argv: list[str]) -> int:
    command, *args = argv or [""]
    if command in STREAMED and args and args[-1] == "--stream":
        return stream_check(command, args[:-1])
    function = _command(command, args)
    try:
        answer = function(args, None) if function else {"error": f"{USAGE}\ngot: {argv}"}
    except TrustError as problem:
        answer = {"error": str(problem)}
    except Exception as error:  # The server reads every failure from stdout.
        answer = {"error": f"{type(error).__name__}: {error}"}
    print(json.dumps(answer, default=str))
    return 1 if "error" in answer else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

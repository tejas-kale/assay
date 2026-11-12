"""Check runs a proposal's Python in a child process, never in the helper that prints the check's events (audit PI-8).

A proposal's code can print anything. Imported into the helper, it could print its own ``done`` event with
``ok: true``. So ``describe`` (which imports the module) and ``run`` (which calls its function on the live run) start
``python -m analysis_child`` and read one JSON answer from a file it writes. Its stdout and stderr are captured and
never reach the event stream; only a failure quotes the end of them, truncated. Only the parent prints events.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import analysis_calc
import analysis_runner
from analysis_calc import TrustError

TIMEOUT_SECONDS = 300
QUOTED_CHARS = 300


def _quote(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= QUOTED_CHARS else "…" + text[-QUOTED_CHARS:]


def _call(op: str, folder: Path, name: str, *more: str) -> dict[str, Any]:
    """The child's answer to ``op``; its ``error`` becomes a ``TrustError`` or an exception of the child's own type."""
    with tempfile.TemporaryDirectory(prefix="assay-child-") as scratch:
        out = Path(scratch) / "answer.json"
        command = [sys.executable, "-B", "-P", "-m", "analysis_child", str(out), op, str(folder), name, *more]
        try:
            done = subprocess.run(
                command,
                cwd=folder,
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise TrustError(
                f"the proposal's code ran for more than {TIMEOUT_SECONDS // 60} minutes and was stopped"
            ) from None
        if not out.is_file():
            said = _quote(done.stderr or done.stdout)
            raise TrustError(
                f"the proposal's code stopped without an answer (exit {done.returncode}){': ' + said if said else ''}"
            )
        answer = json.loads(out.read_text())
    if "error" in answer:
        if answer["trust"]:
            raise TrustError(answer["error"])
        raise type(answer["type"], (Exception,), {})(answer["error"])
    return answer["result"]


def describe(folder: Path, name: str) -> dict[str, Any]:
    """``analysis_calc.describe``, with a Python proposal imported in a child."""
    if not (folder / f"{name}.py").is_file():
        return analysis_calc.describe(folder, name)
    try:
        return _call("describe", folder, name)
    except TrustError:
        raise
    except Exception as error:
        # The form step says what the import said.
        raise TrustError(str(error)) from None


def run(folder: Path, name: str, given: dict[str, Any], analysis: Path) -> dict[str, Any]:
    """``analysis_runner.run`` of a Python proposal, in a child."""
    return _call("run", folder, name, json.dumps(given), str(analysis))


def _child(argv: list[str]) -> None:
    """The child: ``out op folder name [given analysis]``; writes ``{result}`` or ``{error, type, trust}`` to out."""
    out, op, folder, name, *more = argv
    try:
        if op == "describe":
            result = analysis_calc.describe(Path(folder), name)
        else:
            result = analysis_runner.run(Path(folder), name, json.loads(more[0]), Path(more[1]))
        answer: dict[str, Any] = {"result": result}
    except Exception as error:
        answer = {"error": str(error), "type": type(error).__name__, "trust": isinstance(error, TrustError)}
    Path(out).write_text(json.dumps(answer, default=str))


if __name__ == "__main__":
    _child(sys.argv[1:])

"""pytest over a calculation's fixture cases and its own ``test_<name>.py``, each result reported as pytest makes it.

pytest runs in a subprocess, in the calculation's folder, with two modules written into a scratch folder: one test
per fixture case (``analysis_fixtures.run_case``), and a plugin that prints one marked JSON line per test report.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from analysis_fixtures import load_tests

TIMEOUT_SECONDS = 300
OUTPUT_LINES = 12

CASES_MODULE = """import pytest
from pathlib import Path
import analysis_fixtures

FOLDER = Path({folder!r})
NAME = {name!r}


@pytest.mark.parametrize("index", range({count}))
def test_case(index):
    analysis_fixtures.run_case(FOLDER, NAME, index)
"""

# A pytest plugin written into the scratch folder: one marked line per test report, read from piped stdout.
STREAM_MARK = "@@assay-test@@"
STREAM_PLUGIN = """import json
import os
import re
import sys

import pytest

CASES = os.environ.get("ASSAY_CASES_MODULE", "")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if call.excinfo is not None:
        error = call.excinfo.value
        lines = str(error).strip().splitlines()
        report.assay_text = (lines[0] if lines else type(error).__name__)[:300]
        report.assay_diff = getattr(error, "diff", None)


def pytest_runtest_logreport(report):
    if report.when != "call" and report.passed:
        return
    if report.when != "call" and report.skipped:
        return
    path, _, name = report.location
    base = os.path.basename(path)
    name = name.replace(".", "::")
    found = re.fullmatch(r"test_case\\[(\\d+)\\]", name)
    if base == CASES and found:
        name = "case %d" % (int(found.group(1)) + 1)
    else:
        name = base + "::" + name
    event = {"name": name, "ok": report.passed, "text": "PASSED" if report.passed else "FAILED"}
    if report.skipped:
        event["text"] = "SKIPPED"
    elif not report.passed:
        detail = getattr(report, "assay_text", "")
        if detail:
            event["text"] += " " + detail
        if getattr(report, "assay_diff", None):
            event["diff"] = report.assay_diff
    sys.stdout.write("\\n" + {mark!r} + json.dumps(event) + "\\n")
    sys.stdout.flush()
"""

OnTest = Callable[[dict[str, Any]], None]


def run_tests(folder: Path, name: str, on_test: OnTest | None = None) -> dict[str, Any]:
    """pytest over the fixture cases and ``test_<name>.py``.

    Returns whether all passed, pytest's last lines and ``results``, one ``{name, ok, text, diff?}`` per test.
    ``on_test`` is called with each result when pytest reports it.
    """
    count = len(load_tests(folder, name).get("cases") or [])
    own = folder / f"test_{name}.py"
    if count == 0 and not own.is_file():
        return {"passed": False, "output": f"no tests: add cases to {name}.test.yaml or write test_{name}.py"}
    with tempfile.TemporaryDirectory() as scratch:
        cases = _write_cases(Path(scratch), folder, name, count)
        targets = [str(Path(scratch) / cases)] if cases else []
        targets += [str(own)] if own.is_file() else []
        (Path(scratch) / "assay_stream.py").write_text(STREAM_PLUGIN.replace("{mark!r}", repr(STREAM_MARK)))
        python_path = os.pathsep.join(filter(None, [scratch, os.environ.get("PYTHONPATH", "")]))
        pytest = ["-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "assay_stream", "--rootdir", scratch]
        process = subprocess.Popen(
            [sys.executable, *pytest, *targets],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=str(folder),
            env={**os.environ, "ASSAY_CASES_MODULE": cases, "PYTHONPATH": python_path},
        )
        timer = threading.Timer(TIMEOUT_SECONDS, process.kill)
        timer.start()
        try:
            results, lines = _read_reports(process.stdout or [], on_test)
            code = process.wait()
        finally:
            timer.cancel()
    return {"passed": code == 0, "output": "\n".join(lines[-OUTPUT_LINES:]), "results": results}


def _write_cases(scratch: Path, folder: Path, name: str, count: int) -> str:
    """The file name of the module holding one test per fixture case, written into ``scratch``; '' for no cases."""
    if not count:
        return ""
    cases = f"test_cases_{re.sub(r'[^A-Za-z0-9_]', '_', name)}.py"
    (scratch / cases).write_text(CASES_MODULE.format(folder=str(folder), name=name, count=count))
    return cases


def _read_reports(stdout: Iterable[str], on_test: OnTest | None) -> tuple[list[dict[str, Any]], list[str]]:
    """The marked test reports in pytest's output, each passed to ``on_test`` as it comes, and the other lines."""
    results: list[dict[str, Any]] = []
    lines: list[str] = []
    for raw in stdout:
        line = raw.rstrip("\n")
        at = line.find(STREAM_MARK)
        if at < 0:
            if line.strip():
                lines.append(line)
            continue
        try:
            result = json.loads(line[at + len(STREAM_MARK) :])
        except ValueError:
            continue
        results.append(result)
        if on_test is not None:
            on_test(result)
    return results, lines


def result_step(result: dict[str, Any]) -> dict[str, Any]:
    """One test's result as a check's ``test`` step."""
    step = {"step": "test", "ok": result["ok"], "text": result["text"], "name": result["name"]}
    if result.get("diff"):
        step["diff"] = result["diff"]
    return step


def tests_passed(tests: dict[str, Any], emit: OnTest) -> bool:
    """What a test run leaves after its per-test steps: a failing ``tests`` step when pytest itself failed
    (or there was no test). ``emit`` is called with it. True when every test passed."""
    if not tests.get("results") and not tests["passed"]:
        emit({"step": "tests", "ok": False, "text": tests["output"]})
        return False
    if not tests["passed"] and all(result["ok"] for result in tests.get("results") or []):
        emit({"step": "tests", "ok": False, "text": tests["output"]})
        return False
    return tests["passed"]

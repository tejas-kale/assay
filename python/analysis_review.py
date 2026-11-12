"""What the Trust tab shows for a proposal: its code, then each step of its Check as it happens.

A calculation's Check runs form, transpile, the SQL rules, a block's contract, the tests, and a live run (for a block,
its grain and rebuild too). A drafted dictionary entry's runs form, transpile, a case per definition, and a live run
of each. ``ok`` is true only when every step passed: only then may the person approve it.
"""

from __future__ import annotations

import json
import re
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import yaml

import analysis_child
import analysis_runner
import analysis_sql
from analysis_blocks import Block, contract_step, grain_step, rebuild_step
from analysis_calc import (
    DIALECT,
    TrustError,
    block_contract,
    cell,
    convert,
    placeholders,
    plural,
    split_template,
)
from analysis_dictionary import definition_parameters, definitions_of, is_full_name, render_definition
from analysis_fixtures import load_tests, to_duckdb
from analysis_pytest import result_step, run_tests, tests_passed

SAMPLE_ROWS = 5
# What the Trust tab's start event carries from the answer.
START_KEYS = ("name", "kind", "file", "description", "code", "files", "texts", "block")

Emit = Callable[[dict[str, Any]], None]


class Steps:
    """The steps of a check, kept for the answer and, when streaming, passed on as they happen."""

    def __init__(self, emit: Emit | None = None) -> None:
        self.steps: list[dict[str, Any]] = []
        self.emit = emit

    def __call__(self, step: dict[str, Any]) -> None:
        self.steps.append(step)
        if self.emit is not None:
            self.emit({"event": "step", "step": step})

    def start(self, answer: dict[str, Any]) -> None:
        if self.emit is not None:
            self.emit({"event": "start", **{key: answer[key] for key in START_KEYS if key in answer}})

    def tests(self, folder: Path, name: str) -> bool:
        """Runs the tests, one step each as pytest reports it; whether every one passed."""
        result = run_tests(folder, name, lambda found: self(result_step(found)))
        if "results" not in result:
            self({"step": "tests", "ok": False, "text": result["output"]})
            return False
        return tests_passed(result, self)


def rules_step(sql: str, step: Emit) -> bool:
    """The SQL rules on a template, its parameters bound to dummies: a ``rules`` step when it has a CTE or a JOIN.

    True unless a rule rejects it. Warnings pass, listed in the step's text.
    """
    try:
        found = analysis_sql.lint(analysis_sql.bind_dummies(sql), DIALECT)
    except Exception as error:
        step({"step": "rules", "ok": False, "text": f"the SQL rules could not run: {error}"})
        return False
    if found["errors"]:
        step({"step": "rules", "ok": False, "text": "\n".join(f"- {line}" for line in found["errors"])})
        return False
    if re.search(r"\b(WITH|JOIN)\b", sql, re.IGNORECASE):
        warnings = found["warnings"]
        text = "\n".join(["warnings:", *(f"- {line}" for line in warnings)]) if warnings else ""
        step({"step": "rules", "ok": True, "text": text or "grain, joins and names as the rules ask"})
    return True


def _failed(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"


def _sample(columns: list[str], rows: list[list[str]]) -> dict[str, Any]:
    return {"columns": columns, "rows": rows[:SAMPLE_ROWS], "total": len(rows)}


def _read_once(folder: Path, names: list[str]) -> dict[str, str]:
    """Each named file that exists, read exactly once: what the check shows, runs and snapshots, and approval copies.

    Nothing else reads the live draft, so a writer swapping a file mid-check cannot make the check and the approval
    disagree.
    """
    return {name: (folder / name).read_text() for name in names if (folder / name).is_file()}


def _private_copy(texts: dict[str, str]) -> tempfile.TemporaryDirectory[str]:
    """A scratch folder holding exactly ``texts``: the checks that need files on disk run against it, not the draft."""
    scratch = tempfile.TemporaryDirectory(prefix="assay-check-")
    for name, text in texts.items():
        (Path(scratch.name) / name).write_text(text)
    return scratch


def _settled(folder: Path, answer: dict[str, Any], step: Steps) -> dict[str, Any]:
    """The answer, failed with a ``changed`` step when a proposal file no longer holds what the check started with."""
    for file, text in (answer.get("texts") or {}).items():
        if answer["ok"] and (not (folder / file).is_file() or (folder / file).read_text() != text):
            step({"step": "changed", "ok": False, "text": f"{file} changed during the check: check again"})
            answer["ok"] = False
    return answer


# ---------------------------------------------------------------------------
# A trusted calculation.


def check(folder: Path, name: str, analysis: Path, emit: Emit | None = None) -> dict[str, Any]:
    """What the Trust tab shows for a proposal: its code, the tests, the transpile check and a live run.

    ``emit`` gets each event (``start``, ``step``) as it happens.
    """
    beside = [f"{name}.test.yaml", f"test_{name}.py", f"{name}.rebuild.sql"]
    texts = _read_once(folder, [f"{name}.sql", f"{name}.py", *beside])
    with _private_copy(texts) as scratch:
        review = _CalculationCheck(Path(scratch), name, analysis, Steps(emit))
        review.run()
    return _settled(folder, review.answer, review.step)


class _CalculationCheck:
    def __init__(self, folder: Path, name: str, analysis: Path, step: Steps) -> None:
        # ``folder`` is the private copy of the proposal's files: only the check reads it.
        self.folder, self.name, self.analysis, self.step = folder, name, analysis, step
        self.answer: dict[str, Any] = {"name": name, "ok": False, "steps": step.steps}
        self.found: dict[str, Any] = {}

    def run(self) -> None:
        try:
            # A Python proposal is imported in a child, never in this process, which prints the events.
            found = analysis_child.describe(self.folder, self.name)
        except Exception as error:
            self.step({"step": "form", "ok": False, "text": str(error)})
            return
        self.found = found
        self._record_form(found)
        code = self.answer["code"]
        contract = block_contract(split_template(code)[0]) if "block" in found else None
        if found["kind"] == "sql" and not self._sql_steps(found, contract):
            return
        tests = load_tests(self.folder, self.name)
        # A block's fixture cases are optional: its live checks are the grain and the rebuild.
        if (contract is None or tests.get("cases")) and not self.step.tests(self.folder, self.name):
            return
        live_args = tests.get("live")
        if live_args is None and (contract is not None or any(param["required"] for param in found["parameters"])):
            text = f"no live: arguments in {self.name}.test.yaml for the live run"
            self.step({"step": "live", "ok": False, "text": text})
        elif contract is not None:
            self._block_live(found, contract, live_args or {})
        else:
            self._live(live_args or {})

    def _record_form(self, found: dict[str, Any]) -> None:
        """The described calculation into the answer, then the start event and a passing ``form`` step."""
        code = (self.folder / found["file"]).read_text()
        self.answer.update(kind=found["kind"], file=found["file"], description=found["description"], code=code)
        beside = (f"{self.name}.test.yaml", f"test_{self.name}.py", f"{self.name}.rebuild.sql")
        self.answer["files"] = [found["file"], *(f for f in beside if (self.folder / f).is_file())]
        self.answer["texts"] = {file: (self.folder / file).read_text() for file in self.answer["files"]}
        if "block" in found:
            self.answer["block"] = found["block"]
        self.step.start(self.answer)
        what = "SQL block" if "block" in found else "SQL template" if found["kind"] == "sql" else "Python function"
        self.step({"step": "form", "ok": True, "text": f"{what}, {plural(len(found['parameters']), 'parameter')}"})

    def _sql_steps(self, found: dict[str, Any], contract: dict[str, Any] | None) -> bool:
        """transpile, rules and, for a block, contract; ``found["sql"]`` becomes the expanded SQL."""
        try:
            # The analysis is <root>/analyses/<slug>: its root's trusted pieces are what the template may include.
            root = self.analysis.resolve().parent.parent
            found["sql"] = analysis_runner.expand_template(found["sql"], root, self.name)
            self._check_placeholders(found)
            self.step({"step": "transpile", "ok": True, "text": to_duckdb(found["sql"])})
        except Exception as error:
            self.step({"step": "transpile", "ok": False, "text": str(error)})
            return False
        if not rules_step(found["sql"], self.step):
            return False
        return contract is None or contract_step(found["sql"], found["parameters"], contract, self.step)

    @staticmethod
    def _check_placeholders(found: dict[str, Any]) -> None:
        declared = {param["name"] for param in found["parameters"]}
        used = placeholders(found["sql"])
        if used != declared:
            uses = ", :".join(sorted(used)) or "(none)"
            raise TrustError(f"uses :{uses} but declares {', '.join(sorted(declared)) or 'none'}")

    def _live(self, live_args: dict[str, Any]) -> None:
        try:
            if self.found["kind"] == "python":
                table = analysis_child.run(self.folder, self.name, live_args, self.analysis)
            else:
                # Already expanded against the analysis root: the private copy has no shared folder beside it.
                values = convert(self.found["parameters"], live_args)
                table = analysis_runner.run_table(self.found["sql"], values, self.analysis)
        except Exception as error:
            self.step({"step": "live", "ok": False, "text": _failed(error)})
            return
        rows = table["rows"]
        text = f"{plural(len(rows), 'row')} with {json.dumps(live_args, default=str)}"
        self.step({"step": "live", "ok": True, "text": text})
        self.answer.update(ok=True, sample=_sample(table["columns"], rows))

    def _block_live(self, found: dict[str, Any], contract: dict[str, Any], live_args: dict[str, Any]) -> None:
        """A block's live steps: the run, its grain, and the rebuild compared on the same arguments."""
        try:
            values = convert(found["parameters"], live_args)
            columns, rows = analysis_runner.run_rows(found["sql"], values, self.analysis)
        except Exception as error:
            self.step({"step": "live", "ok": False, "text": _failed(error)})
            return
        text = f"{plural(len(rows), 'row')} with {json.dumps(live_args, default=str)}"
        self.step({"step": "live", "ok": True, "text": text})
        if not grain_step(columns, rows, contract["grain"], self.step):
            return
        block = Block(self.folder, self.name, self.analysis, contract, found["parameters"])
        if not rebuild_step(block, values, (columns, rows), self.step):
            return
        self.answer.update(ok=True, sample=_sample(columns, [[cell(v) for v in row] for row in rows]))


# ---------------------------------------------------------------------------
# A drafted dictionary entry.


def check_entry(path: Path, analysis: Path, emit: Emit | None = None) -> dict[str, Any]:
    """What the Trust tab shows for a drafted dictionary entry: its text, whether its form is sound, and its
    definitions' cases and live runs."""
    texts = _read_once(path.parent, [path.name, f"{path.name[: -len('.yaml')]}.test.yaml"])
    with _private_copy(texts) as scratch:
        review = _EntryCheck(Path(scratch) / path.name, analysis, Steps(emit))
        review.run()
    return _settled(path.parent, review.answer, review.step)


class _EntryCheck:
    def __init__(self, path: Path, analysis: Path, step: Steps) -> None:
        # ``path`` is in the private copy of the proposal's files: only the check reads it.
        self.path, self.analysis, self.step = path, analysis, step
        self.name = path.name[: -len(".yaml")]
        self.answer: dict[str, Any] = {
            "name": self.name,
            "ok": False,
            "steps": step.steps,
            "kind": "dictionary",
            "file": path.name,
        }

    def run(self) -> None:
        try:
            # The text goes in the answer first: the Trust tab shows it even when it does not parse.
            if not self.path.is_file():
                raise TrustError(f"{self.path.name} does not exist")
            self.answer["code"] = self.path.read_text()
            data = yaml.safe_load(self.answer["code"])
            columns = self._check_form(data)
        except Exception as error:
            self.step({"step": "form", "ok": False, "text": str(error)})
            return
        self._record_form(data, columns)
        definitions = self._transpile(data)
        if definitions is None:
            return
        if not definitions:
            self.answer["ok"] = True
            return
        self.step({"step": "transpile", "ok": True, "text": plural(len(definitions), "definition")})
        tests = load_tests(self.path.parent, self.name)
        if self._untested(definitions, tests) or not self.step.tests(self.path.parent, self.name):
            return
        self.answer["ok"] = self._live(data, definitions, tests.get("live") or {})

    def _record_form(self, data: dict[str, Any], columns: list[Any]) -> None:
        """The entry's description and files into the answer, then the start event and a passing ``form`` step."""
        self.answer["description"] = str(data["description"]).strip().splitlines()[0]
        tests = f"{self.name}.test.yaml"
        self.answer["files"] = [self.path.name, *([tests] if (self.path.parent / tests).is_file() else [])]
        self.answer["texts"] = {file: (self.path.parent / file).read_text() for file in self.answer["files"]}
        self.step.start(self.answer)
        self.step({"step": "form", "ok": True, "text": plural(len(columns), "column")})

    def _check_form(self, data: Any) -> list[Any]:
        """The entry's columns; a TrustError when its name, description or columns are not sound."""
        if not is_full_name(self.name):
            raise TrustError("name the file catalog.schema.table.yaml")
        if not isinstance(data, dict) or not str(data.get("description") or "").strip():
            raise TrustError("needs a description")
        columns = data.get("columns") or []
        if not isinstance(columns, list) or not all(isinstance(c, dict) and c.get("name") for c in columns):
            raise TrustError("columns must be a list, each with a name")
        return columns

    def _transpile(self, data: dict[str, Any]) -> list[dict[str, Any]] | None:
        try:
            definitions = definitions_of(data)
            for item in definitions:
                to_duckdb(render_definition(data, self.name, item["name"], {}))
        except Exception as error:
            self.step({"step": "transpile", "ok": False, "text": str(error)})
            return None
        return definitions

    def _untested(self, definitions: list[dict[str, Any]], tests: dict[str, Any]) -> bool:
        """Whether a definition has no case, said in a failing ``tests`` step."""
        tested = {str(case.get("definition")) for case in tests.get("cases") or [] if isinstance(case, dict)}
        untested = [item["name"] for item in definitions if item["name"] not in tested]
        if untested:
            text = f"no case in {self.name}.test.yaml for {', '.join(untested)}"
            self.step({"step": "tests", "ok": False, "text": text})
        return bool(untested)

    def _live(self, data: dict[str, Any], definitions: list[dict[str, Any]], live: dict[str, Any]) -> bool:
        """A live run of each definition, on its ``live:`` arguments; the first one's rows are the sample."""
        said = []
        for item in definitions:
            try:
                values = convert(definition_parameters(item["kind"]), live.get(item["name"]) or {})
                sql = render_definition(data, self.name, item["name"], values)
                table = analysis_runner.run_live_sql(sql, self.analysis)
            except Exception as error:
                self.step({"step": "live", "ok": False, "text": f"{item['name']}: {_failed(error)}"})
                return False
            said.append(f"{item['name']} {plural(len(table['rows']), 'row')}")
            self.answer.setdefault("sample", _sample(table["columns"], table["rows"]))
        self.step({"step": "live", "ok": True, "text": ", ".join(said)})
        return True

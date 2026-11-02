"""The format examples in plugin/skills/propose-trusted/SKILL.md pass analysis_trust's form and fixture steps.

An example is the fenced block right after a ``<!-- example: <draft path> -->`` line; its path is where it lands in
an analysis (``lib/trusted/...`` or ``lib/dictionaries/...``). Edit an example into an invalid form and this fails.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analysis_trust as trust  # noqa: E402

SKILL = Path(__file__).resolve().parents[2] / "plugin" / "skills" / "propose-trusted" / "SKILL.md"
EXAMPLE = re.compile(r"<!-- example: (\S+) -->\n```\w*\n(.*?)\n```", re.DOTALL)


def examples() -> dict[str, str]:
    found = {path: body + "\n" for path, body in EXAMPLE.findall(SKILL.read_text())}
    assert found, "no examples found in the skill"
    return found


@pytest.fixture
def analysis(tmp_path: Path) -> Path:
    """An analysis folder holding every example at its draft path."""
    for path, body in examples().items():
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)
    return tmp_path


def steps_before_live(answer: dict) -> list[tuple[str, bool]]:
    return [(step["step"], step["ok"]) for step in answer["steps"] if step["step"] != "live"]


def test_the_skill_holds_one_example_per_kind() -> None:
    assert sorted(examples()) == [
        "lib/dictionaries/main.panel.surveys.test.yaml",
        "lib/dictionaries/main.panel.surveys.yaml",
        "lib/trusted/completes_by_site.sql",
        "lib/trusted/completes_by_site.test.yaml",
        "lib/trusted/test_top_sites.py",
        "lib/trusted/top_sites.py",
    ]


def check_without_live(monkeypatch: pytest.MonkeyPatch, check, *args):
    """The check's answer; the live step runs against no warehouse here, so it is stubbed and left out."""
    monkeypatch.setattr(trust, "run", lambda *a, **k: {"columns": [], "rows": []})
    monkeypatch.setattr(trust, "run_live_sql", lambda *a, **k: {"columns": [], "rows": []})
    return check(*args)


def test_the_sql_template_passes_form_transpile_and_fixture_cases(analysis: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = analysis / "lib" / "trusted"
    answer = check_without_live(monkeypatch, trust.check, folder, "completes_by_site", analysis)
    assert steps_before_live(answer) == [("form", True), ("transpile", True), ("test", True)]
    assert trust.load_tests(folder, "completes_by_site").get("live"), "the fixture has live arguments"
    assert answer["ok"] is True


def test_the_python_function_passes_form_and_its_own_pytest(analysis: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = analysis / "lib" / "trusted"
    answer = check_without_live(monkeypatch, trust.check, folder, "top_sites", analysis)
    assert steps_before_live(answer) == [("form", True), ("test", True)]
    assert answer["ok"] is True


def test_the_dictionary_entry_passes_form_transpile_and_its_definition_case(analysis: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    draft = analysis / "lib" / "dictionaries" / "main.panel.surveys.yaml"
    answer = check_without_live(monkeypatch, trust.check_entry, draft, analysis)
    assert steps_before_live(answer) == [("form", True), ("transpile", True), ("test", True)]
    assert answer["ok"] is True


def test_an_invalid_example_fails(analysis: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sql = analysis / "lib" / "trusted" / "completes_by_site.sql"
    sql.write_text(sql.read_text().replace(":status", ":state"))
    answer = check_without_live(monkeypatch, trust.check, sql.parent, "completes_by_site", analysis)
    assert answer["ok"] is False and ("transpile", False) in steps_before_live(answer)

"""Tests for analysis_trust: <venv>/bin/python -m pytest python/tests"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ledger_helper import approve

import analysis_calc as calc
import analysis_db
import analysis_dictionary as entries
import analysis_fixtures as fixtures
import analysis_library as library
import analysis_pytest as pyt
import analysis_review as review
import analysis_runner as runner
import analysis_trust as trust

SHORT_COMMIT = 12  # characters of a commit hash in a recorded source
SAMPLE_ROWS = 2
SHOWN_DIFF_LINES = 41  # 40 lines of a long diff and the "… N more" line


def test_table_names_skip_ctes_and_keep_the_parts_written() -> None:
    sql = """
        WITH recent AS (SELECT * FROM main.panel.surveys WHERE day > current_date() - 7)
        SELECT * FROM recent r
        JOIN panel.sites s ON s.id = r.site_id
        JOIN `Main`.panel.Completes c ON c.survey_id = r.id
        LEFT JOIN lookups l USING (id)
    """
    assert entries.table_names(sql) == ["lookups", "main.panel.completes", "main.panel.surveys", "panel.sites"]


@pytest.fixture
def notes_src(tmp_path: Path) -> Path:
    folder = tmp_path / "dictionaries"
    folder.mkdir()
    (folder / "main.panel.surveys.yaml").write_text("description: One row per survey; a Complete is counted once.\n")
    (folder / "main.panel.sites.yaml").write_text("description: Sites.\n")
    (folder / "other.panel.sites.yaml").write_text("description: Sites elsewhere.\n")
    (folder / "main.panel.surveys.test.yaml").write_text("tables: {}\n")
    (folder / "glossary.yaml").write_text("terms:\n  complete: A finished survey.\n  quota: A cap.\n")
    return tmp_path


def test_dictionary_resolves_full_and_unique_partial_names(notes_src: Path) -> None:
    found = entries.dictionary(notes_src, "SELECT * FROM surveys JOIN panel.sites ON 1 = 1 JOIN x.y.z ON 1 = 1")
    assert found["tables"] == [
        {"name": "panel.sites"},
        {
            "name": "surveys",
            "entry": "main.panel.surveys",
            "text": "description: One row per survey; a Complete is counted once.\n",
            "terms": ["complete"],
        },
        {"name": "x.y.z"},
    ]
    assert found["glossary"] == {"complete": "A finished survey."}


def test_the_command_prints_json_and_an_error_on_bad_sql(
    notes_src: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    sql = tmp_path / "q.sql"
    sql.write_text("SELECT * FROM main.panel.sites\n")
    assert trust.main(["dictionary", str(notes_src), str(sql)]) == 0
    assert json.loads(capsys.readouterr().out)["tables"][0]["entry"] == "main.panel.sites"
    sql.write_text("SELECT * FROM (\n")
    assert trust.main(["dictionary", str(notes_src), str(sql)]) == 1
    assert "error" in json.loads(capsys.readouterr().out)


# ---------------------------------------------------------------------------
# Trusted calculations.

TEMPLATE = """/*---
description: Completes per site between two days.
parameters:
  start: date
  end: date
  status: {type: string, default: C}
---*/
SELECT site_id, count(*) AS completes
FROM main.panel.surveys
WHERE status = :status AND day BETWEEN :start AND :end
GROUP BY site_id
"""

TEMPLATE_TESTS = """tables:
  main.panel.surveys: |
    id,site_id,status,day
    1,10,C,2026-01-02
    2,10,C,2026-01-03
    3,11,C,2026-01-03
    4,11,S,2026-01-03
    5,12,C,2026-02-01
cases:
  - args: {start: 2026-01-01, end: 2026-01-31, status: C}
    expect: |
      site_id,completes
      10,2
      11,1
live: {start: 2026-01-01, end: 2026-01-31, status: C}
"""

FUNCTION = '''from datetime import date

import pandas as pd
from sqlalchemy import text


def top_sites(engine, limit: int = 2):
    """The sites with the most completes, most first."""
    query = text(
        "SELECT site_id, count(*) AS completes FROM panel.surveys "
        "GROUP BY site_id ORDER BY completes DESC, site_id LIMIT :limit"
    )
    with engine.connect() as connection:
        return pd.read_sql(query, connection, params={"limit": limit})
'''

FUNCTION_TEST = """import analysis_trust
from top_sites import top_sites

TABLES = {"panel.surveys": "id,site_id\\n1,10\\n2,10\\n3,11\\n"}


def test_top_site_first():
    frame = top_sites(analysis_trust.fixture_engine(TABLES), limit=1)
    assert frame["site_id"].tolist() == [10]
"""


def commit_all(folder: Path) -> None:
    for args in (["init", "-q"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]):
        subprocess.run(["git", "-C", str(folder), *args], check=True)
    approve(folder)


@pytest.fixture
def trusted(tmp_path: Path) -> Path:
    folder = tmp_path / "trusted"
    folder.mkdir()
    (folder / "completes_by_site.sql").write_text(TEMPLATE)
    (folder / "completes_by_site.test.yaml").write_text(TEMPLATE_TESTS)
    (folder / "top_sites.py").write_text(FUNCTION)
    (folder / "test_top_sites.py").write_text(FUNCTION_TEST)
    (folder / "broken.sql").write_text("SELECT 1\n")
    return folder


def test_list_describes_each_calculation_with_its_commit(trusted: Path) -> None:
    commit_all(trusted.parent)
    (trusted / "top_sites.py").write_text(FUNCTION + "\n")
    listed = library.list_calculations(trusted.parent)
    by_name = {calc["name"]: calc for calc in listed["calculations"]}
    sql = by_name["completes_by_site"]
    assert sql["kind"] == "sql" and sql["description"] == "Completes per site between two days."
    assert sql["parameters"] == [
        {"name": "start", "type": "date", "required": True},
        {"name": "end", "type": "date", "required": True},
        {"name": "status", "type": "string", "required": False},
    ]
    assert len(sql["commit"]) == SHORT_COMMIT and sql["dirty"] is False
    py = by_name["top_sites"]
    assert py["kind"] == "python" and py["dirty"] is True
    assert py["parameters"] == [] and py["description"].startswith("Not approved")  # its code is not run to describe it
    approve(trusted.parent, "trusted/top_sites.py")
    py = next(c for c in library.list_calculations(trusted.parent)["calculations"] if c["name"] == "top_sites")
    assert py["dirty"] is False and py["parameters"] == [{"name": "limit", "type": "integer", "required": False}]
    assert listed["problems"] == [
        "broken: no front matter: start the file with a /*--- ... ---*/ block holding description and parameters"
    ]


def test_arguments_are_checked_against_their_types() -> None:
    params = calc.parameters_of({"start": "date", "n": "integer", "flag": {"type": "boolean", "default": False}})
    assert calc.convert(params, {"start": "2026-01-02", "n": 3})["start"].isoformat() == "2026-01-02"
    for given, said in [
        ({"start": "2026-01-02"}, "missing argument: n"),
        ({"start": "2026-01-02", "n": "3"}, "argument n must be a integer"),
        ({"start": "Jan 2", "n": 3}, "argument start must be a date as YYYY-MM-DD"),
        ({"start": "2026-01-02", "n": 3, "x": 1}, "unknown arguments: x"),
        ({"start": "2026-01-02", "n": True}, "argument n must be a integer"),
    ]:
        with pytest.raises(calc.TrustError, match=said):
            calc.convert(params, given)


def test_a_template_transpiles_and_its_fixture_cases_pass(trusted: Path) -> None:
    assert calc.placeholders(calc.split_template(TEMPLATE)[1]) == {"start", "end", "status"}
    fixtures.run_case(trusted, "completes_by_site", 0)
    assert pyt.run_tests(trusted, "completes_by_site")["passed"] is True


def test_a_failing_case_fails_the_tests(trusted: Path) -> None:
    (trusted / "completes_by_site.test.yaml").write_text(TEMPLATE_TESTS.replace("10,2", "10,3"))
    with pytest.raises(AssertionError, match="rows"):
        fixtures.run_case(trusted, "completes_by_site", 0)
    result = pyt.run_tests(trusted, "completes_by_site")
    assert result["passed"] is False and "failed" in result["output"]


def test_a_python_calculation_runs_its_own_tests(trusted: Path) -> None:
    result = pyt.run_tests(trusted, "top_sites")
    assert result["passed"] is True and "1 passed" in result["output"]


def test_without_tests_nothing_passes(trusted: Path) -> None:
    (trusted / "test_top_sites.py").unlink()
    assert pyt.run_tests(trusted, "top_sites") == {
        "passed": False,
        "output": "no tests: add cases to top_sites.test.yaml or write test_top_sites.py",
    }


def test_check_runs_every_step_and_a_live_run(trusted: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tables = yaml_tables()
    on_cint(trusted)
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: fixtures.fixture_engine(tables))
    answer = review.check(trusted, "completes_by_site", tmp_path)
    assert [(step["step"], step["ok"]) for step in answer["steps"]] == [
        ("form", True),
        ("transpile", True),
        ("test", True),
        ("live", True),
    ]
    assert answer["steps"][0]["text"] == "SQL template, 3 parameters"
    assert answer["steps"][2]["name"] == "case 1"
    assert answer["ok"] is True
    sample = answer["sample"]
    assert sample["columns"] == ["site_id", "completes"] and sample["total"] == SAMPLE_ROWS
    assert sorted(sample["rows"]) == [["10", "2"], ["11", "1"]]
    assert answer["files"] == ["completes_by_site.sql", "completes_by_site.test.yaml"]
    assert answer["code"] == TEMPLATE.replace("main.panel", "cint.panel")


def test_check_snapshots_every_proposal_file_and_fails_when_one_changes_during_the_check(
    trusted: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    tables = yaml_tables()
    on_cint(trusted)
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: fixtures.fixture_engine(tables))
    answer = review.check(trusted, "completes_by_site", tmp_path)
    assert answer["texts"] == {name: (trusted / name).read_text() for name in answer["files"]}

    def edit_companion(event: dict[str, Any]) -> None:
        if event.get("step", {}).get("step") == "test":
            (trusted / "completes_by_site.test.yaml").write_text("cases: []\n")

    changed = review.check(trusted, "completes_by_site", tmp_path, edit_companion)
    assert changed["ok"] is False
    assert changed["steps"][-1] == {
        "step": "changed",
        "ok": False,
        "text": "completes_by_site.test.yaml changed during the check: check again",
    }


def swapping_after_first_read(monkeypatch: pytest.MonkeyPatch, folder: Path, evil: str) -> None:
    """Every file under ``folder`` reads as it is the first time, then as ``evil``: a writer racing the check."""
    real, seen = Path.read_text, set()

    def read_text(self: Path, *args: Any, **kwargs: Any) -> str:
        if self.parent != folder:
            return real(self, *args, **kwargs)
        if self in seen:
            return evil
        seen.add(self)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)


def test_a_calculation_swapped_after_it_is_read_is_shown_checked_and_approved_as_read(
    trusted: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    tables = yaml_tables()
    on_cint(trusted)
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: fixtures.fixture_engine(tables))
    benign = (trusted / "completes_by_site.sql").read_text()
    swapping_after_first_read(monkeypatch, trusted, "/*---\ndescription: evil\n---*/\nDROP TABLE x\n")
    answer = review.check(trusted, "completes_by_site", tmp_path)
    assert answer["code"] == answer["texts"]["completes_by_site.sql"] == benign
    assert all("evil" not in text for text in answer["texts"].values())


def test_an_entry_swapped_after_it_is_read_is_shown_checked_and_approved_as_read(
    draft: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = draft / "main.panel.surveys.yaml"
    benign = path.read_text()
    swapping_after_first_read(monkeypatch, draft, "description: evil\n")
    answer = review.check_entry(path, tmp_path)
    assert answer["code"] == answer["texts"]["main.panel.surveys.yaml"] == benign
    assert all("evil" not in text for text in answer["texts"].values())


def test_a_missing_entry_fails_its_form_step(tmp_path: Path) -> None:
    answer = review.check_entry(tmp_path / "main.panel.gone.yaml", tmp_path)
    assert answer["steps"] == [{"step": "form", "ok": False, "text": "main.panel.gone.yaml does not exist"}]


def yaml_tables() -> dict[str, str]:
    """The fixture tables under catalog cint: a live engine on DuckDB cannot have a catalog named main."""
    return {name.replace("main.", "cint."): text for name, text in yaml.safe_load(TEMPLATE_TESTS)["tables"].items()}


def on_cint(folder: Path) -> None:
    """The template reading catalog cint, for a live run on DuckDB."""
    (folder / "completes_by_site.sql").write_text(TEMPLATE.replace("main.panel", "cint.panel"))
    (folder / "completes_by_site.test.yaml").write_text(TEMPLATE_TESTS.replace("main.panel", "cint.panel"))


def test_check_stops_at_a_template_whose_parameters_do_not_match(trusted: Path, tmp_path: Path) -> None:
    (trusted / "completes_by_site.sql").write_text(TEMPLATE.replace("  status: {type: string, default: C}\n", ""))
    answer = review.check(trusted, "completes_by_site", tmp_path)
    assert answer["ok"] is False
    assert answer["steps"][-1] == {
        "step": "transpile",
        "ok": False,
        "text": "uses :end, :start, :status but declares end, start",
    }


CTE_TEMPLATE = TEMPLATE.replace(
    "SELECT site_id, count(*) AS completes\nFROM main.panel.surveys\n"
    "WHERE status = :status AND day BETWEEN :start AND :end\nGROUP BY site_id\n",
    "WITH sv AS (SELECT * FROM main.panel.surveys WHERE status = :status AND day BETWEEN :start AND :end)\n"
    "SELECT site_id, count(*) AS completes FROM sv GROUP BY site_id\n",
)


def test_check_fails_a_template_that_breaks_the_sql_rules(trusted: Path, tmp_path: Path) -> None:
    (trusted / "completes_by_site.sql").write_text(CTE_TEMPLATE)
    answer = review.check(trusted, "completes_by_site", tmp_path)
    assert answer["ok"] is False
    assert [(step["step"], step["ok"]) for step in answer["steps"]] == [
        ("form", True),
        ("transpile", True),
        ("rules", False),
    ]
    assert answer["steps"][-1]["text"] == (
        '- CTE sv: no "-- grain:" line above it.\n- CTE sv: name too short; say what it holds.\n'
        '- Final SELECT: no "-- grain:" line above it.'
    )


def test_a_template_that_follows_the_rules_passes_its_rules_step() -> None:
    steps: list[dict[str, Any]] = []
    body = (
        calc.split_template(CTE_TEMPLATE)[1]
        .replace("WITH sv AS", "WITH\n-- grain: id\nrecent_surveys AS")
        .replace("FROM sv", "FROM recent_surveys")
    )
    body = body.replace("SELECT site_id, count", "-- grain: site_id\nSELECT site_id, count")
    assert review.rules_step(body, steps.append) is True
    assert steps == [{"step": "rules", "ok": True, "text": "grain, joins and names as the rules ask"}]
    plain: list[dict[str, Any]] = []
    assert review.rules_step(calc.split_template(TEMPLATE)[1], plain.append) is True and plain == []


def test_check_needs_live_arguments_for_required_parameters(trusted: Path, tmp_path: Path) -> None:
    (trusted / "completes_by_site.test.yaml").write_text(TEMPLATE_TESTS.split("live:", maxsplit=1)[0])
    answer = review.check(trusted, "completes_by_site", tmp_path)
    assert answer["steps"][-1] == {
        "step": "live",
        "ok": False,
        "text": "no live: arguments in completes_by_site.test.yaml for the live run",
    }


def test_run_binds_arguments_as_parameters(trusted: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tables = {**yaml_tables(), "panel.surveys": "id,site_id\n1,10\n2,10\n3,11\n"}
    on_cint(trusted)
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: fixtures.fixture_engine(tables))
    # A value that would break SQL pasted in is only a value.
    result = runner.run(
        trusted, "completes_by_site", {"start": "2026-01-01", "end": "2026-01-31", "status": "C' OR '1'='1"}, tmp_path
    )
    assert result == {"columns": ["site_id", "completes"], "rows": []}
    top = runner.run(trusted, "top_sites", {"limit": 1}, tmp_path)
    assert top == {"columns": ["site_id", "completes"], "rows": [["10", "2"]]}


def test_the_run_command_reports_a_problem_as_json(
    trusted: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    approve(tmp_path)
    assert trust.main(["run", str(tmp_path), "completes_by_site", '{"start": 1}', str(tmp_path)]) == 1
    assert json.loads(capsys.readouterr().out) == {"error": "argument start must be a date"}


def test_a_drafted_entry_is_checked_for_its_form(tmp_path: Path) -> None:
    draft = tmp_path / "main.panel.sites.yaml"
    draft.write_text("description: Sites.\ncolumns:\n  - name: id\n    type: bigint\n")
    answer = review.check_entry(draft, tmp_path)
    assert answer["ok"] is True and answer["files"] == ["main.panel.sites.yaml"]
    assert answer["steps"] == [{"step": "form", "ok": True, "text": "1 column"}]
    draft.write_text("columns: []\n")
    steps = review.check_entry(draft, tmp_path)["steps"]
    assert steps == [{"step": "form", "ok": False, "text": "needs a description"}]


# ---------------------------------------------------------------------------
# Definitions.

ENTRY = """description: One row per survey.
columns:
  - {name: id, type: bigint, description: The survey.}
  - {name: site_id, type: bigint, description: The site.}
  - {name: status, type: string, description: C when complete.}
definitions:
  - name: completes
    kind: metric
    description: Surveys finished.
    sql: count_if(status = 'C')
  - name: is_complete
    kind: filter
    description: Finished surveys only.
    sql: status = 'C'
  - name: site_label
    kind: derived
    description: The site as text.
    sql: concat('site ', site_id)
"""

ENTRY_TESTS = """tables:
  main.panel.surveys: |
    id,site_id,status
    1,10,C
    2,10,S
    3,11,C
cases:
  - definition: completes
    args: {by: [site_id]}
    expect: |
      site_id,completes
      10,1
      11,1
  - definition: is_complete
    expect: |
      is_complete
      2
  - definition: site_label
    args: {by: [id], filters: [is_complete], limit: 5}
    expect: |
      id,site_label
      1,site 10
      3,site 11
"""


def test_a_definition_renders_with_checked_names_only() -> None:
    data = yaml.safe_load(ENTRY)
    t = "main.panel.surveys"
    assert entries.render_definition(data, t, "completes", {"by": ["Site_Id"]}) == (
        "-- grain: site_id\n"
        "SELECT `site_id`, count_if(status = 'C') AS `completes` FROM `main`.`panel`.`surveys` GROUP BY `site_id`"
    )
    assert entries.render_definition(data, t, "is_complete", {}) == (
        "-- grain: none\nSELECT count(*) AS `is_complete` FROM `main`.`panel`.`surveys` WHERE (status = 'C')"
    )
    assert entries.render_definition(data, t, "site_label", {"filters": ["is_complete"]}) == (
        "SELECT *, concat('site ', site_id) AS `site_label` FROM `main`.`panel`.`surveys` WHERE (status "
        "= 'C') LIMIT 100"
    )
    with pytest.raises(calc.TrustError, match="by: x; DROP is not a column"):
        entries.render_definition(data, t, "completes", {"by": ["x; DROP"]})
    with pytest.raises(calc.TrustError, match="filters: completes is not a filter"):
        entries.render_definition(data, t, "completes", {"filters": ["completes"]})


@pytest.fixture
def draft(tmp_path: Path) -> Path:
    folder = tmp_path / "lib" / "dictionaries"
    folder.mkdir(parents=True)
    (folder / "main.panel.surveys.yaml").write_text(ENTRY)
    (folder / "main.panel.surveys.test.yaml").write_text(
        ENTRY_TESTS.replace("cases:", "live:\n  completes: {by: [site_id]}\ncases:")
    )
    return folder


def test_a_draft_with_definitions_runs_their_cases_and_a_live_run_each(
    draft: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    tables = {"cint.panel.surveys": "id,site_id,status\n1,10,C\n"}
    (draft / "main.panel.surveys.yaml").write_text(ENTRY)
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: fixtures.fixture_engine(tables))
    # The live engine is DuckDB here, with no catalog named main: point the draft's live runs at cint.
    monkeypatch.setattr(runner, "run_live_sql", lambda sql, _: _on_duckdb(sql.replace("`main`", "`cint`"), tables))
    answer = review.check_entry(draft / "main.panel.surveys.yaml", tmp_path)
    assert [(step["step"], step["ok"]) for step in answer["steps"]] == [
        ("form", True),
        ("transpile", True),
        ("test", True),
        ("test", True),
        ("test", True),
        ("live", True),
    ]
    assert answer["steps"][-1]["text"] == "completes 1 row, is_complete 1 row, site_label 1 row"
    assert answer["ok"] is True
    assert answer["files"] == ["main.panel.surveys.yaml", "main.panel.surveys.test.yaml"]


def _on_duckdb(sql: str, tables: dict[str, str]) -> dict[str, Any]:
    engine = fixtures.fixture_engine(tables)
    with engine.connect() as connection:
        result = connection.exec_driver_sql(fixtures.to_duckdb(sql))
        return {"columns": list(result.keys()), "rows": [[calc.cell(v) for v in row] for row in result]}


def test_a_definition_without_a_case_cannot_pass(draft: Path, tmp_path: Path) -> None:
    (draft / "main.panel.surveys.test.yaml").write_text(ENTRY_TESTS.split("  - definition: site_label", maxsplit=1)[0])
    answer = review.check_entry(draft / "main.panel.surveys.yaml", tmp_path)
    assert answer["ok"] is False
    assert answer["steps"][-1] == {
        "step": "tests",
        "ok": False,
        "text": "no case in main.panel.surveys.test.yaml for site_label",
    }


def test_a_failing_definition_case_fails(draft: Path, tmp_path: Path) -> None:
    (draft / "main.panel.surveys.test.yaml").write_text(ENTRY_TESTS.replace("      2\n", "      3\n"))
    answer = review.check_entry(draft / "main.panel.surveys.yaml", tmp_path)
    failed = [step for step in answer["steps"] if step["step"] == "test" and not step["ok"]]
    assert answer["ok"] is False and [step["name"] for step in failed] == ["case 2"]


def test_definitions_are_listed_as_calculations_with_their_entry_commit(tmp_path: Path) -> None:
    folder = tmp_path / "dictionaries"
    folder.mkdir()
    (folder / "main.panel.surveys.yaml").write_text(ENTRY)
    (folder / "main.panel.sites.yaml").write_text("description: no definitions\n")
    commit_all(tmp_path)
    listed = library.list_calculations(tmp_path)
    names = [calc["name"] for calc in listed["calculations"]]
    assert names == ["main.panel.surveys:completes", "main.panel.surveys:is_complete", "main.panel.surveys:site_label"]
    first = listed["calculations"][0]
    assert first["kind"] == "definition" and first["path"] == "dictionaries/main.panel.surveys.yaml"
    assert first["description"] == "metric on main.panel.surveys: Surveys finished."
    assert [p["name"] for p in first["parameters"]] == ["by", "filters"]
    assert [p["name"] for p in listed["calculations"][2]["parameters"]] == ["by", "filters", "limit"]
    assert first["dirty"] is False and len(first["commit"]) == SHORT_COMMIT
    assert runner.render(tmp_path, "main.panel.surveys:completes", {"by": ["site_id"]}).endswith("GROUP BY `site_id`")
    with pytest.raises(calc.TrustError, match="argument by must be a list of names"):
        runner.render(tmp_path, "main.panel.surveys:completes", {"by": "site_id"})


# ---------------------------------------------------------------------------
# check --stream.


def stream(capsys: pytest.CaptureFixture[str], *argv: str) -> list[dict[str, Any]]:
    trust.main([*argv, "--stream"])
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_a_stream_prints_start_then_each_step_then_done(
    trusted: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    tables = yaml_tables()
    on_cint(trusted)
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: fixtures.fixture_engine(tables))
    events = stream(capsys, "check", str(trusted), "completes_by_site", str(tmp_path))
    assert [event["event"] for event in events] == ["start", "step", "step", "step", "step", "done"]
    start = events[0]
    assert (start["name"], start["kind"], start["file"]) == ("completes_by_site", "sql", "completes_by_site.sql")
    assert start["files"] == ["completes_by_site.sql", "completes_by_site.test.yaml"]
    assert [event["step"]["step"] for event in events[1:5]] == ["form", "transpile", "test", "live"]
    assert events[3]["step"] == {"step": "test", "ok": True, "text": "PASSED", "name": "case 1"}
    done = events[-1]["answer"]
    assert done["ok"] is True and done["steps"] == [event["step"] for event in events[1:5]]


def test_a_failing_case_streams_a_diff_of_expected_and_got(
    trusted: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (trusted / "completes_by_site.test.yaml").write_text(TEMPLATE_TESTS.replace("10,2", "10,3"))
    events = stream(capsys, "check", str(trusted), "completes_by_site", str(tmp_path))
    failed = next(event["step"] for event in events if event["event"] == "step" and event["step"]["step"] == "test")
    assert failed["ok"] is False and failed["name"] == "case 1"
    assert failed["text"].startswith("FAILED rows")
    assert failed["diff"].splitlines() == ["  site_id,completes", "- 10.0,3.0", "+ 10.0,2.0", "  11.0,1.0"]
    assert events[-1]["answer"]["ok"] is False


def test_a_long_diff_is_cut(trusted: Path) -> None:
    lines = [f"{n}" for n in range(100)]
    diff = fixtures.line_diff(lines, [])
    assert diff.splitlines()[-1] == "… 60 more" and len(diff.splitlines()) == SHOWN_DIFF_LINES


def test_a_calculations_own_test_is_named_in_a_step(
    trusted: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    events = stream(capsys, "check", str(trusted), "top_sites", str(tmp_path))
    tests = [event["step"] for event in events if event["event"] == "step" and event["step"]["step"] == "test"]
    assert tests == [{"step": "test", "ok": True, "text": "PASSED", "name": "test_top_sites.py::test_top_site_first"}]
    form = next(event["step"] for event in events if event["event"] == "step")
    assert form["text"] == "Python function, 1 parameter"


def test_a_stream_without_any_test_fails_with_a_tests_step(
    trusted: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (trusted / "test_top_sites.py").unlink()
    events = stream(capsys, "check", str(trusted), "top_sites", str(tmp_path))
    assert events[-2]["step"] == {
        "step": "tests",
        "ok": False,
        "text": "no tests: add cases to top_sites.test.yaml or write test_top_sites.py",
    }
    assert events[-1]["answer"]["ok"] is False


def test_a_form_failure_streams_a_step_then_done_without_start(
    trusted: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    events = stream(capsys, "check", str(trusted), "nothing", str(tmp_path))
    assert [event["event"] for event in events] == ["step", "done"]
    assert events[0]["step"]["step"] == "form" and events[0]["step"]["ok"] is False


def test_a_dictionary_entrys_cases_stream_by_number(
    draft: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    events = stream(capsys, "check-entry", str(draft / "main.panel.surveys.yaml"), str(tmp_path))
    assert events[0]["event"] == "start" and events[0]["kind"] == "dictionary"
    names = [event["step"]["name"] for event in events if event["event"] == "step" and event["step"]["step"] == "test"]
    assert names == ["case 1", "case 2", "case 3"]
    assert events[-1]["event"] == "done"


def test_an_unexpected_error_streams_done_with_an_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(*_: Any, **__: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(review, "check", boom)
    assert [event for event in stream(capsys, "check", str(tmp_path), "x", str(tmp_path))] == [
        {"event": "done", "answer": {"error": "RuntimeError: boom"}}
    ]


def test_without_stream_the_output_is_one_object(
    trusted: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    trust.main(["check", str(trusted), "top_sites", str(tmp_path)])
    out = capsys.readouterr().out.splitlines()
    assert len(out) == 1 and json.loads(out[0])["name"] == "top_sites"

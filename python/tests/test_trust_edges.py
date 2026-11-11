"""The error paths of the trust modules: each TrustError a calculation, an entry or a check can meet, as said today."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pandas as pd
import polars as pl
import pytest
import yaml

import analysis_blocks as blocks
import analysis_calc as calc
import analysis_db
import analysis_dictionary as entries
import analysis_fixtures as fixtures
import analysis_library as library
import analysis_pytest as pyt
import analysis_review as review
import analysis_runner as runner
import analysis_sql
import analysis_trust as trust

PYTHON = Path(sys.executable)
HALF = 1.5


def problem(call: Any, *args: Any) -> str:
    with pytest.raises(calc.TrustError) as raised:
        call(*args)
    return str(raised.value)


def on_fixtures(monkeypatch: pytest.MonkeyPatch, tables: dict[str, str]) -> None:
    """The analysis's warehouse as DuckDB holding ``tables``."""
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: fixtures.fixture_engine(tables))


def offline(*_: Any, **__: Any) -> Any:
    raise ConnectionError("offline")


# ---------------------------------------------------------------------------
# Tables and the dictionary.


def test_table_names_skip_empty_statements_and_table_functions() -> None:
    assert entries.table_names("SELECT 1;;") == []
    assert entries.table_names("SELECT * FROM range(3)") == []


def test_without_a_glossary_no_terms_are_named(tmp_path: Path) -> None:
    assert entries.read_glossary(tmp_path) == {}


def test_a_glossary_may_list_its_terms(tmp_path: Path) -> None:
    (tmp_path / "dictionaries").mkdir()
    terms = "terms:\n  - {term: quota, description: A cap.}\n  - not a term\n"
    (tmp_path / "dictionaries" / "glossary.yaml").write_text(terms)
    assert entries.read_glossary(tmp_path) == {"quota": "A cap."}


# ---------------------------------------------------------------------------
# Calculations' form.


def test_a_templates_front_matter_must_be_a_mapping() -> None:
    assert problem(calc.split_template, "/*---\n- a\n---*/\nSELECT 1") == "the front matter is not a mapping"


def test_a_parameter_has_a_known_type() -> None:
    said = problem(calc.parameters_of, {"n": "decimal"})
    assert said == "parameter n: type 'decimal' is not one of string, integer, number, boolean, date"


@pytest.mark.parametrize(
    ("code", "said"),
    [
        ("def other(engine):\n    pass\n", "calc.py has no function calc"),
        ("def calc(engine):\n    pass\n", "calc has no docstring"),
        ('def calc():\n    """Doc."""\n', "calc takes no engine: its first parameter must be the SQLAlchemy engine"),
        ('def calc(engine, n: list):\n    """Doc."""\n', "parameter n: annotate it with str, int, float, bool or date"),
    ],
)
def test_a_python_calculation_has_its_function_docstring_and_annotations(tmp_path: Path, code: str, said: str) -> None:
    (tmp_path / "calc.py").write_text(code)
    assert problem(calc.python_function, tmp_path / "calc.py") == said


def test_a_python_calculation_must_be_importable(tmp_path: Path) -> None:
    (tmp_path / "calc.txt").write_text("")
    assert problem(calc.load_module, tmp_path / "calc.txt") == "cannot import calc.txt"


def test_a_template_needs_a_description(tmp_path: Path) -> None:
    (tmp_path / "calc.sql").write_text("/*---\nparameters: {}\n---*/\nSELECT 1 AS one\n")
    assert problem(calc.describe, tmp_path, "calc") == "calc.sql: the front matter has no description"


@pytest.mark.parametrize(
    ("block", "said"),
    [
        ("block: [a]", "block: is a mapping with grain and columns"),
        ("block: {grain: []}", "block: columns maps each output column to what it means"),
        ("block: {grain: [], columns: {a: ''}}", "block: column a says nothing about what it means"),
        ("block: {grain: a, columns: {a: The a.}}", "block: grain is a list of columns, [] for one row"),
        ("block: {grain: [b], columns: {a: The a.}}", "block: grain column b is not one of its columns"),
    ],
)
def test_a_block_contract_is_checked(block: str, said: str) -> None:
    assert problem(calc.block_contract, yaml.safe_load(block)) == said


def test_a_block_of_grain_none_is_one_row() -> None:
    contract = calc.block_contract({"block": {"grain": "none", "columns": {"n": "The count."}}})
    assert contract == {"grain": [], "columns": {"n": "The count."}}


@pytest.mark.parametrize(
    ("sql", "said"),
    [
        ("SELECT 1 AS a; SELECT 2 AS a", "is 2 statements, not one"),
        ("INSERT INTO t VALUES (1)", "is not a query"),
        ("SELECT * FROM t", "name every output column: no *"),
        ("SELECT t.* FROM t", "name every output column: no *"),
        ("SELECT a + 1 FROM t", "name every output column: give each expression an AS name"),
    ],
)
def test_a_blocks_output_columns_are_named(sql: str, said: str) -> None:
    assert problem(blocks.output_columns, sql) == said


# ---------------------------------------------------------------------------
# Definitions.

ENTRY = {
    "columns": [{"name": "id"}],
    "definitions": [{"name": "rows", "kind": "derived", "description": "Rows.", "sql": "1"}],
}


def test_an_entry_is_a_mapping(tmp_path: Path) -> None:
    (tmp_path / "a.b.c.yaml").write_text("- a\n")
    assert problem(entries.read_entry, tmp_path / "a.b.c.yaml") == "a.b.c.yaml is not a mapping"


@pytest.mark.parametrize(
    ("item", "said"),
    [
        ("x", "each definition is a mapping"),
        ({"name": "Bad"}, "definition 'Bad': a name is lower case, digits and _"),
        ({"name": "n", "kind": "sum"}, "definition n: kind is one of metric, filter, derived"),
        ({"name": "n", "kind": "metric", "sql": "1"}, "definition n: needs a description and sql"),
    ],
)
def test_each_definition_is_checked(item: Any, said: str) -> None:
    assert problem(entries.definitions_of, {"definitions": [item]}) == said


def test_a_definition_must_exist_and_take_a_positive_limit() -> None:
    render = entries.render_definition
    assert problem(render, ENTRY, "a.b.c", "nope", {}) == "a.b.c has no definition nope"
    assert problem(render, ENTRY, "a.b.c", "rows", {"limit": 0}) == "limit must be a positive integer"
    assert problem(render, ENTRY, "a.b.c", "rows", {"limit": True}) == "limit must be a positive integer"


def test_a_definition_is_found_by_table_and_name(tmp_path: Path) -> None:
    assert problem(entries.describe_definition, tmp_path, "a.b.c:rows") == "no dictionary entry a.b.c"
    (tmp_path / "a.b.c.yaml").write_text(yaml.safe_dump(ENTRY))
    assert problem(entries.describe_definition, tmp_path, "a.b.c:nope") == "a.b.c has no definition nope"


def test_a_broken_entry_is_listed_as_a_problem(tmp_path: Path) -> None:
    (tmp_path / "dictionaries").mkdir()
    (tmp_path / "dictionaries" / "a.b.c.yaml").write_text("definitions: [x]\n")
    listed = library.list_calculations(tmp_path)
    assert listed == {"calculations": [], "problems": ["a.b.c.yaml: each definition is a mapping"]}


def test_git_answers_nothing_when_it_cannot_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subprocess, "run", offline)
    assert library.git(tmp_path, "status") == ""


# ---------------------------------------------------------------------------
# Values and frames.


def test_cells_and_frames() -> None:
    assert calc.cell(None) == ""
    assert calc.frame_table(pl.DataFrame({"a": [1, None]})) == {"columns": ["a"], "rows": [["1"], [""]]}
    assert calc.frame_table(pd.DataFrame({"a": [1]})) == {"columns": ["a"], "rows": [["1"]]}
    assert problem(calc.frame_table, [1]) == "the function returned a list, not a data frame"


def test_comparable_values_and_parsed_cells() -> None:
    assert calc.comparable(None) is None
    assert calc.comparable(True) is True
    assert fixtures.parse_cell("") is None
    assert fixtures.parse_cell(str(HALF)) == HALF
    assert fixtures.parse_cell("a") == "a"


def test_a_statement_that_is_not_one_or_does_not_parse_does_not_transpile() -> None:
    assert problem(fixtures.to_duckdb, "SELECT 1; SELECT 2") == "is 2 statements, not one"
    assert problem(fixtures.to_duckdb, "SELECT * FROM (").startswith("does not transpile to DuckDB: ")


def test_a_result_with_other_columns_fails_its_case() -> None:
    with pytest.raises(fixtures.MismatchError, match=r"columns \['b'\] != expected \['a'\]"):
        fixtures.compare(["b"], [(1.0,)], "a\n1\n", ordered=False)


# ---------------------------------------------------------------------------
# Running.


def test_a_definition_runs_its_rendered_sql(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "dictionaries").mkdir()
    (tmp_path / "dictionaries" / "a.b.c.yaml").write_text(yaml.safe_dump(ENTRY))
    on_fixtures(monkeypatch, {"a.b.c": "id\n1\n2\n"})
    sql = runner.render(tmp_path, "a.b.c:rows", {"by": ["id"]})
    ran = runner.run_live_sql(fixtures.to_duckdb(sql), tmp_path)
    assert ran == {"columns": ["id", "rows"], "rows": [["1", "1"], ["2", "1"]]}
    monkeypatch.setattr(runner, "run_live_sql", lambda sql, analysis: {"sql": sql})
    sent = runner.run(tmp_path / "trusted", "a.b.c:rows", {}, tmp_path)
    assert sent == {"sql": "SELECT *, 1 AS `rows` FROM `a`.`b`.`c` LIMIT 100"}


FUNCTION = '''import pandas as pd
from sqlalchemy import text

QUERY = "SELECT site_id, count(*) AS n FROM panel.surveys GROUP BY site_id ORDER BY n DESC LIMIT :limit"


def top_sites(engine, limit: int = 2):
    """The sites with the most completes."""
    with engine.connect() as connection:
        return pd.read_sql(text(QUERY), connection, params={"limit": limit})
'''


def test_a_python_calculations_case_runs_on_fixture_tables(tmp_path: Path) -> None:
    (tmp_path / "top_sites.py").write_text(FUNCTION)
    tables = {"panel.surveys": "id,site_id\n1,10\n2,10\n3,11\n"}
    case = {"args": {"limit": 1}, "expect": "site_id,n\n10,2\n"}
    (tmp_path / "top_sites.test.yaml").write_text(yaml.safe_dump({"tables": tables, "cases": [case]}))
    fixtures.run_case(tmp_path, "top_sites", 0)


# ---------------------------------------------------------------------------
# Tests and checks.


def test_a_test_run_without_results_or_with_every_result_passing_still_fails_when_pytest_did() -> None:
    said: list[dict[str, Any]] = []
    assert pyt.tests_passed({"passed": False, "output": "error"}, said.append) is False
    assert pyt.tests_passed({"passed": False, "output": "boom", "results": [{"ok": True}]}, said.append) is False
    assert said == [{"step": "tests", "ok": False, "text": "error"}, {"step": "tests", "ok": False, "text": "boom"}]


def test_a_test_file_that_breaks_pytest_is_a_failing_tests_step(tmp_path: Path) -> None:
    (tmp_path / "test_calc.py").write_text("import nothing_at_all\n")
    result = pyt.run_tests(tmp_path, "calc")
    assert result["passed"] is False and result["results"] == []
    steps: list[dict[str, Any]] = []
    assert pyt.tests_passed(result, steps.append) is False
    assert steps[0]["step"] == "tests" and "nothing_at_all" in steps[0]["text"]


def test_a_marked_line_that_is_not_json_is_skipped(tmp_path: Path) -> None:
    (tmp_path / "test_calc.py").write_text(f"def test_a():\n    print({pyt.STREAM_MARK + '{'!r})\n")
    result = pyt.run_tests(tmp_path, "calc")
    assert result["passed"] is True and [r["name"] for r in result["results"]] == ["test_calc.py::test_a"]


def test_the_rules_that_cannot_run_fail_their_step(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_: Any) -> Any:
        raise ValueError("bad")

    monkeypatch.setattr(analysis_sql, "lint", broken)
    steps: list[dict[str, Any]] = []
    assert review.rules_step("SELECT 1", steps.append) is False
    assert steps == [{"step": "rules", "ok": False, "text": "the SQL rules could not run: bad"}]


def test_a_rebuild_may_not_use_a_parameter_the_block_does_not_declare(tmp_path: Path) -> None:
    (tmp_path / "b.rebuild.sql").write_text("-- rebuilt by: codex\nSELECT :x AS a\n")
    steps: list[dict[str, Any]] = []
    block = blocks.Block(tmp_path, "b", tmp_path, {"grain": [], "columns": {"a": "The a."}}, [])
    assert blocks.rebuild_step(block, {}, (["a"], [(1,)]), steps.append) is False
    said = "b.rebuild.sql uses :x, which the block does not declare"
    assert steps == [{"step": "rebuild", "ok": False, "text": said}]


BLOCK = """/*---
description: Sites.
parameters: {}
block:
  grain: []
  columns: {n: The count.}
---*/
-- grain: none
SELECT count(*) AS n FROM cint.panel.sites
"""


def block_folder(tmp_path: Path) -> Path:
    folder = tmp_path / "analyses" / "a" / "lib" / "trusted"
    folder.mkdir(parents=True)
    (folder / "sites.sql").write_text(BLOCK)
    (folder / "sites.test.yaml").write_text("live: {}\n")
    return folder


def test_a_block_whose_live_run_fails_stops_there(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(analysis_db, "engine", offline)
    answer = review.check(block_folder(tmp_path), "sites", tmp_path / "analyses" / "a")
    assert answer["ok"] is False
    assert answer["steps"][-1] == {"step": "live", "ok": False, "text": "ConnectionError: offline"}


def test_a_block_of_one_row_passes_its_grain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = block_folder(tmp_path)
    (folder / "sites.rebuild.sql").write_text("-- rebuilt by: codex\nSELECT count(*) AS n FROM cint.panel.sites\n")
    on_fixtures(monkeypatch, {"cint.panel.sites": "id\n1\n2\n"})
    answer = review.check(folder, "sites", tmp_path / "analyses" / "a")
    grain = next(step for step in answer["steps"] if step["step"] == "grain")
    assert grain == {"step": "grain", "ok": True, "text": "grain none (one row): 1 row"}
    assert answer["ok"] is True and answer["sample"] == {"columns": ["n"], "rows": [["2.0"]], "total": 1}


@pytest.mark.parametrize(
    ("name", "text", "said"),
    [
        ("sites.yaml", "description: Sites.\n", "name the file catalog.schema.table.yaml"),
        ("a.b.c.yaml", "description: Sites.\ncolumns: [{type: int}]\n", "columns must be a list, each with a name"),
    ],
)
def test_a_drafted_entrys_form_is_checked(tmp_path: Path, name: str, text: str, said: str) -> None:
    (tmp_path / name).write_text(text)
    assert review.check_entry(tmp_path / name, tmp_path)["steps"] == [{"step": "form", "ok": False, "text": said}]


def test_a_drafted_entrys_definitions_must_transpile(tmp_path: Path) -> None:
    definition = {"name": "n", "kind": "metric", "description": "N.", "sql": "count(("}
    (tmp_path / "a.b.c.yaml").write_text(yaml.safe_dump({"description": "C.", "definitions": [definition]}))
    step = review.check_entry(tmp_path / "a.b.c.yaml", tmp_path)["steps"][-1]
    assert step["step"] == "transpile" and step["ok"] is False
    assert step["text"].startswith("does not transpile to DuckDB: ")


def test_a_drafted_entrys_live_run_that_fails_stops_there(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "a.b.c.yaml").write_text(yaml.safe_dump({"description": "C.", **ENTRY}))
    case = {"definition": "rows", "args": {"by": ["id"]}, "expect": "id,rows\n1,1\n"}
    (tmp_path / "a.b.c.test.yaml").write_text(yaml.safe_dump({"tables": {"a.b.c": "id\n1\n"}, "cases": [case]}))
    monkeypatch.setattr(runner, "run_live_sql", offline)
    step = review.check_entry(tmp_path / "a.b.c.yaml", tmp_path)["steps"][-1]
    assert step == {"step": "live", "ok": False, "text": "rows: ConnectionError: offline"}


# ---------------------------------------------------------------------------
# The command line.


def answer(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, Any]:
    code = trust.main(list(argv))
    return code, json.loads(capsys.readouterr().out)


def test_the_commands_answer_in_json(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / "dictionaries").mkdir()
    entry = tmp_path / "dictionaries" / "a.b.c.yaml"
    entry.write_text(yaml.safe_dump(ENTRY))
    not_json = (1, {"error": "the arguments are not a JSON object"})
    assert answer(capsys, "list", str(tmp_path))[1]["calculations"][0]["name"] == "a.b.c:rows"
    sql = "SELECT *, 1 AS `rows` FROM `a`.`b`.`c` LIMIT 100"
    assert answer(capsys, "render", str(tmp_path), "a.b.c:rows", "{}") == (0, {"sql": sql})
    assert answer(capsys, "render", str(tmp_path), "a.b.c:rows", "[]") == not_json
    assert answer(capsys, "run", str(tmp_path), "x", "[]", str(tmp_path)) == not_json
    assert answer(capsys, "check-entry", str(entry), str(tmp_path))[1]["steps"][0]["step"] == "form"
    code, said = answer(capsys, "nothing")
    assert code == 1 and said["error"].endswith("got: ['nothing']")


def test_a_stream_with_the_wrong_arguments_says_how_to_call_it(capsys: pytest.CaptureFixture[str]) -> None:
    assert trust.main(["check", "a", "--stream"]) == 1
    done = json.loads(capsys.readouterr().out)
    assert done["event"] == "done" and done["answer"]["error"].endswith("got: check ['a'] --stream")


def test_fixture_engine_is_still_reached_through_analysis_trust() -> None:
    assert trust.fixture_engine is fixtures.fixture_engine
    with pytest.raises(AttributeError, match="has no attribute 'nothing'"):
        _ = trust.nothing


def test_the_module_runs_as_a_command(tmp_path: Path) -> None:
    ran = subprocess.run(
        [PYTHON, "-m", "analysis_trust", "list", str(tmp_path)],
        capture_output=True,
        text=True,
        cwd=Path(__file__).parents[1],
        check=False,
    )
    assert ran.returncode == 0 and json.loads(ran.stdout) == {"calculations": [], "problems": []}

"""Tests for include by name (docs/slice-10.md, slice 10c): <venv>/bin/python -m pytest python/tests"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analysis_calc as calc
import analysis_db
import analysis_fixtures as fixtures
import analysis_review as review
import analysis_runner as runner
import analysis_sql as sql_

SHORT_COMMIT = 12  # characters of a commit hash in a recorded source

BLOCK = """/*---
description: One row per entry session in a date range.
parameters:
  start: date
  end: date
  limit_to: {type: integer, default: 0}
block:
  grain: [session_id]
  columns:
    session_id: the session
    buyer_id: the buyer
    status: the client status
---*/
-- grain: session_id
SELECT s.session_id, s.buyer_id, s.status
FROM cint.mkt.sessions s
WHERE s.day BETWEEN :start AND :end AND {{ client_entry(s) }}
"""

BUYERS = """/*---
description: One row per buyer.
parameters: {}
block:
  grain: [buyer_id]
  columns:
    buyer_id: the buyer
    name: its name
---*/
-- grain: buyer_id
SELECT b.buyer_id, b.name FROM cint.mkt.buyers b
"""

CALC = """/*---
description: Sessions per day.
parameters:
  day: date
---*/
SELECT count(*) AS n FROM cint.mkt.sessions WHERE day = :day
"""

ENTRY = """description: Sessions.
columns:
  - {name: session_id, type: bigint, description: The session.}
  - {name: status, type: int, description: Status.}
definitions:
  - name: client_entry
    kind: filter
    description: Sessions that entered the client survey.
    sql: lk_responsestatusid = 3 AND surveyid > 0
  - name: is_complete
    kind: filter
    description: Completes.
    sql: status = 1
"""

OTHER = """description: Other sessions.
columns:
  - {name: id, type: bigint, description: Id.}
definitions:
  - name: is_complete
    kind: filter
    description: Completes there.
    sql: state = 'C'
"""


def commit_all(folder: Path) -> None:
    for args in (["init", "-q"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]):
        subprocess.run(["git", "-C", str(folder), *args], check=True)


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "trusted").mkdir()
    (tmp_path / "dictionaries").mkdir()
    (tmp_path / "trusted" / "client_entry_sessions.sql").write_text(BLOCK)
    (tmp_path / "trusted" / "all_buyers.sql").write_text(BUYERS)
    (tmp_path / "trusted" / "sessions_per_day.sql").write_text(CALC)
    (tmp_path / "dictionaries" / "cint.mkt.sessions.yaml").write_text(ENTRY)
    (tmp_path / "dictionaries" / "cint.mkt.other.yaml").write_text(OTHER)
    commit_all(tmp_path)
    return tmp_path


QUERY = """WITH
-- grain: session_id
sessions AS ({{ client_entry_sessions(start => '2026-11-01', end => '2026-11-08') }}),
-- grain: buyer_id
buyers AS ({{ all_buyers() }})
-- grain: buyer_id
SELECT b.buyer_id, count(*) AS n
FROM sessions s
-- join: many:1 on buyer_id
JOIN buyers b ON b.buyer_id = s.buyer_id
GROUP BY b.buyer_id
"""


def test_sql_without_includes_comes_back_unchanged(root: Path) -> None:
    assert sql_.expand("SELECT 1", "databricks", root) == {
        "sql": "SELECT 1",
        "lint_sql": "SELECT 1",
        "retype_sql": "SELECT 1",
        "built_from": [],
        "blocks": [],
    }


def test_blocks_expand_as_cte_bodies_with_their_definitions_and_list_what_the_query_is_built_from(root: Path) -> None:
    found = sql_.expand(QUERY, "databricks", root)
    assert "errors" not in found, found
    assert (
        "sessions AS (SELECT s.session_id, s.buyer_id, s.status FROM cint.mkt.sessions AS s WHERE s.day "
        "BETWEEN CAST('2026-11-01' AS DATE) AND CAST('2026-11-08' AS DATE) AND (s.lk_responsestatusid = "
        "3 AND s.surveyid > 0))" in found["sql"]
    )
    assert "buyers AS (SELECT b.buyer_id, b.name FROM cint.mkt.buyers AS b)" in found["sql"]
    assert [(piece["name"], piece["kind"]) for piece in found["built_from"]] == [
        ("client_entry_sessions", "block"),
        ("cint.mkt.sessions:client_entry", "definition"),
        ("all_buyers", "block"),
    ]
    assert all(len(piece["commit"]) == SHORT_COMMIT for piece in found["built_from"])
    assert found["blocks"] == [
        {"cte": "sessions", "name": "client_entry_sessions"},
        {"cte": "buyers", "name": "all_buyers"},
    ]
    assert "sessions AS (SELECT session_id, buyer_id, status FROM client_entry_sessions)" in found["lint_sql"]
    # The written comments stay, so the lint and the steps read the grain lines.
    assert "-- grain: session_id\nsessions AS (" in found["sql"]
    assert sql_.lint(found["lint_sql"])["errors"] == []


def test_positional_arguments_and_postgres(root: Path) -> None:
    found = sql_.expand(
        "WITH\n-- grain: session_id\nx AS ({{ client_entry_sessions('2026-11-01', '2026-11-08', 5) }})\n"
        "-- grain: session_id\nSELECT * FROM x",
        "postgres",
        root,
    )
    assert "errors" not in found, found
    assert "CAST('2026-11-01' AS DATE)" in found["sql"]


def test_a_definition_expands_on_its_alias_by_short_or_full_name(root: Path) -> None:
    found = sql_.expand("SELECT * FROM cint.mkt.sessions s WHERE {{ client_entry(s) }}", "databricks", root)
    assert found["sql"] == "SELECT * FROM cint.mkt.sessions s WHERE (s.lk_responsestatusid = 3 AND s.surveyid > 0)"
    assert found["lint_sql"] == found["sql"]
    assert found["built_from"][0]["name"] == "cint.mkt.sessions:client_entry"
    full = sql_.expand("SELECT * FROM t o WHERE {{ cint.mkt.other:is_complete(o) }}", "databricks", root)
    assert full["sql"] == "SELECT * FROM t o WHERE (o.state = 'C')"


@pytest.mark.parametrize(
    ("query", "said"),
    [
        (
            "SELECT * FROM t s WHERE {{ is_complete(s) }}",
            "is_complete names definitions on several tables: write one of cint.mkt.other:is_complete, "
            "cint.mkt.sessions:is_complete",
        ),
        ("SELECT * FROM t s WHERE {{ client_entry() }}", "a definition takes the alias of its table"),
        ("SELECT * FROM t WHERE {{ nothing(s) }}", "no trusted block or definition named nothing"),
        ("SELECT * FROM t WHERE {{ cint.mkt.sessions:nope(s) }}", "no definition cint.mkt.sessions:nope"),
        ("SELECT * FROM ({{ all_buyers() }}) b", "a block is the whole body of a CTE"),
        (
            "WITH x AS ({{ sessions_per_day('2026-01-01') }}) SELECT * FROM x",
            "is a calculation, not a block or definition",
        ),
        ("WITH x AS ({{ client_entry_sessions(start => '2026-11-01') }}) SELECT * FROM x", "missing argument: end"),
        (
            "WITH x AS ({{ client_entry_sessions(start => 'soon', end => '2026-11-08') }}) SELECT * FROM x",
            "argument start must be a date as YYYY-MM-DD",
        ),
        (
            "WITH x AS "
            "({{ client_entry_sessions(start => '2026-11-01', end => '2026-11-08', who => 1) }}) SELECT "
            "* FROM x",
            "unknown arguments: who",
        ),
        ("WITH x AS ({{ client_entry_sessions(2026-11-01, '2026-11-08') }}) SELECT * FROM x", "is not a literal"),
    ],
)
def test_misused_pieces_are_rejected(root: Path, query: str, said: str) -> None:
    found = sql_.expand(query, "databricks", root)
    assert "errors" in found and said in " ".join(found["errors"]), found


def test_a_piece_changed_since_its_commit_is_rejected(root: Path) -> None:
    (root / "trusted" / "all_buyers.sql").write_text(BUYERS.replace("its name", "the name"))
    found = sql_.expand("WITH\n-- grain: buyer_id\nb AS ({{ all_buyers() }})\nSELECT * FROM b", "databricks", root)
    assert "all_buyers differs from its last commit" in found["errors"][0]


def test_a_block_may_not_include_a_block(root: Path) -> None:
    (root / "trusted" / "nested.sql").write_text(
        BUYERS.replace(
            "SELECT b.buyer_id, b.name FROM cint.mkt.buyers b",
            "WITH\n-- grain: buyer_id\ninner_buyers AS ({{ all_buyers() }})\n-- grain: buyer_id\n"
            "SELECT buyer_id, name FROM inner_buyers",
        )
    )
    commit_all(root)
    found = sql_.expand("WITH\n-- grain: buyer_id\nb AS ({{ nested() }})\nSELECT * FROM b", "databricks", root)
    assert "block nested includes block all_buyers" in found["errors"][0]
    with pytest.raises(calc.TrustError, match="includes block all_buyers"):
        runner.expand_template((root / "trusted" / "nested.sql").read_text(), root, "nested")


def test_lineage_and_steps_draw_a_block_as_one_node_and_one_step(root: Path) -> None:
    expanded = sql_.expand(QUERY, "databricks", root)["sql"]
    blocks = {"sessions": "client_entry_sessions", "buyers": "all_buyers"}
    graph = sql_.lineage(expanded, "databricks", blocks=blocks)
    nodes = {node["id"]: node for node in graph["nodes"]}
    assert nodes["sessions"]["block"] == "client_entry_sessions" and nodes["sessions"]["grain"] == ["session_id"]
    # The tables inside a block are not drawn.
    assert "cint.mkt.sessions" not in nodes and "cint.mkt.buyers" not in nodes
    plan = sql_.steps(expanded, "databricks", blocks=blocks)
    first, second, final = plan["steps"]
    assert (first["name"], first.get("block"), first.get("joins")) == ("sessions", "client_entry_sessions", None)
    assert second["block"] == "all_buyers" and "assay_grain_rows" in second["counts"]
    assert final["joins"][0]["source"] == "buyers"


def test_the_expand_command_reads_stdin(
    root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("SELECT * FROM t s WHERE {{ client_entry(s) }}"))
    assert sql_.main(["expand", "databricks", str(root)]) == 0
    assert json.loads(capsys.readouterr().out)["built_from"][0]["kind"] == "definition"
    monkeypatch.setattr(sys, "stdin", io.StringIO(sql_.expand(QUERY, "databricks", root)["sql"]))
    assert sql_.main(["steps", "databricks", "--blocks", "sessions=client_entry_sessions,buyers=all_buyers"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert [step.get("block") for step in out["steps"]] == ["client_entry_sessions", "all_buyers", None]


def test_a_template_including_a_definition_is_checked_expanded(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    analysis = root / "analyses" / "a"
    drafts = analysis / "lib" / "trusted"
    drafts.mkdir(parents=True)
    (drafts / "entry_sessions.sql").write_text(BLOCK.replace("  limit_to: {type: integer, default: 0}\n", ""))
    (drafts / "entry_sessions.test.yaml").write_text("live: {start: 2026-11-01, end: 2026-11-30}\n")
    (drafts / "entry_sessions.rebuild.sql").write_text(
        "-- rebuilt by: codex\nSELECT session_id, buyer_id, status FROM cint.mkt.sessions\n"
        "WHERE day >= :start AND day <= :end AND lk_responsestatusid = 3 AND surveyid > 0\n"
    )
    tables = {
        "cint.mkt.sessions": "session_id,buyer_id,status,day,lk_responsestatusid,surveyid\n"
        "1,10,1,2026-11-02,3,7\n2,10,1,2026-11-03,2,7\n3,11,2,2026-11-04,3,8\n"
    }
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: fixtures.fixture_engine(tables))
    answer = review.check(drafts, "entry_sessions", analysis)
    assert [(step["step"], step["ok"]) for step in answer["steps"]] == [
        ("form", True),
        ("transpile", True),
        ("contract", True),
        ("live", True),
        ("grain", True),
        ("rebuild", True),
    ], answer["steps"]
    assert "{{ client_entry(s) }}" in answer["code"]

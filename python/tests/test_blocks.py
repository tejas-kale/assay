"""Tests for trusted blocks (docs/slice-10.md, slice 10b): <venv>/bin/python -m pytest python/tests"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analysis_trust as trust  # noqa: E402

BLOCK = """/*---
description: One row per entry session in a date range, with its buyer's name.
parameters:
  start: date
  end: date
block:
  grain: [session_id]
  columns:
    session_id: the session
    buyer: the name of the buyer that bought it
    day: the entry day
---*/
-- grain: session_id
SELECT s.session_id, b.name AS buyer, s.day
FROM cint.mkt.sessions s
-- join: many:1 on buyer_id
JOIN cint.mkt.buyers b ON b.buyer_id = s.buyer_id
WHERE s.day BETWEEN :start AND :end
"""

REBUILD = """-- rebuilt by: codex
SELECT ses.session_id AS session_id, ses.day AS day, buy.name AS buyer
FROM cint.mkt.sessions ses, cint.mkt.buyers buy
WHERE buy.buyer_id = ses.buyer_id AND ses.day >= :start AND ses.day <= :end
"""

TABLES = {
    "cint.mkt.sessions": "session_id,buyer_id,day\n1,10,2026-11-01\n2,10,2026-11-02\n3,11,2026-11-02\n4,11,2026-12-01\n",
    "cint.mkt.buyers": "buyer_id,name\n10,Acme\n11,Bolt\n",
}

TESTS = "live: {start: 2026-11-01, end: 2026-11-30}\n"


@pytest.fixture
def drafts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    import analysis_db

    folder = tmp_path / "lib" / "trusted"
    folder.mkdir(parents=True)
    (folder / "entry_sessions.sql").write_text(BLOCK)
    (folder / "entry_sessions.rebuild.sql").write_text(REBUILD)
    (folder / "entry_sessions.test.yaml").write_text(TESTS)
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: trust.fixture_engine(TABLES))
    return folder


def steps(answer: dict) -> list[tuple[str, bool]]:
    return [(step["step"], step["ok"]) for step in answer["steps"]]


def text_of(answer: dict, name: str) -> str:
    return next(step["text"] for step in answer["steps"] if step["step"] == name)


def test_describe_and_list_carry_the_block_contract(drafts: Path) -> None:
    found = trust.describe(drafts, "entry_sessions")
    assert found["kind"] == "sql"
    assert found["block"] == {"grain": ["session_id"], "columns": ["session_id", "buyer", "day"]}


def test_a_block_passes_contract_grain_and_rebuild(drafts: Path, tmp_path: Path) -> None:
    answer = trust.check(drafts, "entry_sessions", tmp_path)
    assert steps(answer) == [("form", True), ("transpile", True), ("rules", True), ("contract", True), ("live", True), ("grain", True), ("rebuild", True)]
    assert answer["ok"] is True
    assert text_of(answer, "form") == "SQL block, 2 parameters"
    assert text_of(answer, "contract") == "params start, end -> grain session_id -> 3 columns"
    assert text_of(answer, "grain") == "grain session_id: 3 rows, 3 distinct"
    assert text_of(answer, "rebuild") == "block and rebuild (codex) agree: 3 rows"
    assert answer["files"] == ["entry_sessions.sql", "entry_sessions.test.yaml", "entry_sessions.rebuild.sql"]
    assert answer["sample"]["total"] == 3


def test_the_contract_must_match_the_sql(drafts: Path, tmp_path: Path) -> None:
    (drafts / "entry_sessions.sql").write_text(BLOCK.replace("    day: the entry day\n", "    entry_day: the entry day\n"))
    answer = trust.check(drafts, "entry_sessions", tmp_path)
    assert steps(answer)[-1] == ("contract", False)
    assert text_of(answer, "contract") == "the SQL returns session_id, buyer, day; the contract says session_id, buyer, entry_day"
    (drafts / "entry_sessions.sql").write_text(BLOCK.replace("-- grain: session_id\n", "-- grain: session_id, day\n"))
    assert text_of(trust.check(drafts, "entry_sessions", tmp_path), "contract") == "the final SELECT's grain line says session_id, day; the contract says session_id"


def test_a_long_block_warns_but_passes(drafts: Path, tmp_path: Path) -> None:
    padding = "".join(f"-- note {i}\n" for i in range(30))
    (drafts / "entry_sessions.sql").write_text(BLOCK.replace("-- grain: session_id\n", padding + "-- grain: session_id\n"))
    answer = trust.check(drafts, "entry_sessions", tmp_path)
    assert answer["ok"] is True
    assert "warning: 36 lines; a block is about 30 at most" in text_of(answer, "contract")


def test_a_block_needs_live_arguments(drafts: Path, tmp_path: Path) -> None:
    (drafts / "entry_sessions.test.yaml").write_text("{}\n")
    answer = trust.check(drafts, "entry_sessions", tmp_path)
    assert steps(answer)[-1] == ("live", False)


def test_duplicate_grain_rows_fail(drafts: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import analysis_db

    doubled = {**TABLES, "cint.mkt.buyers": "buyer_id,name\n10,Acme\n10,Acme Ltd\n11,Bolt\n"}
    monkeypatch.setattr(analysis_db, "engine", lambda start=None, **_: trust.fixture_engine(doubled))
    answer = trust.check(drafts, "entry_sessions", tmp_path)
    assert steps(answer)[-1] == ("grain", False)
    assert text_of(answer, "grain") == "grain session_id has 2 duplicate rows"


def test_rows_on_one_side_only_fail_the_rebuild(drafts: Path, tmp_path: Path) -> None:
    (drafts / "entry_sessions.rebuild.sql").write_text(REBUILD.replace("ses.day <= :end", "ses.day < :end AND ses.buyer_id = 10"))
    answer = trust.check(drafts, "entry_sessions", tmp_path)
    assert steps(answer)[-1] == ("rebuild", False)
    lines = text_of(answer, "rebuild").splitlines()
    assert lines[0] == "1 row only in the block, 0 only in the rebuild (codex)"
    assert lines[1:] == ["session_id,buyer,day", "block only:   3,Bolt,2026-11-02"]


def test_the_rebuild_must_exist_be_signed_and_return_the_contract(drafts: Path, tmp_path: Path) -> None:
    rebuild = drafts / "entry_sessions.rebuild.sql"
    rebuild.write_text(REBUILD.replace("-- rebuilt by: codex\n", ""))
    assert text_of(trust.check(drafts, "entry_sessions", tmp_path), "rebuild") == "entry_sessions.rebuild.sql has no '-- rebuilt by: codex|copilot-opus' line"
    rebuild.write_text(REBUILD.replace("AS buyer", "AS buyer_name"))
    assert "returns session_id, day, buyer_name" in text_of(trust.check(drafts, "entry_sessions", tmp_path), "rebuild")
    rebuild.write_text(REBUILD.replace("codex", "copilot-opus"))
    assert text_of(trust.check(drafts, "entry_sessions", tmp_path), "rebuild") == "block and rebuild (copilot-opus) agree: 3 rows"
    rebuild.unlink()
    assert text_of(trust.check(drafts, "entry_sessions", tmp_path), "rebuild").startswith("no entry_sessions.rebuild.sql")


def test_a_bad_contract_is_a_form_problem(drafts: Path, tmp_path: Path) -> None:
    (drafts / "entry_sessions.sql").write_text(BLOCK.replace("  grain: [session_id]\n", "  grain: [sid]\n"))
    answer = trust.check(drafts, "entry_sessions", tmp_path)
    assert steps(answer) == [("form", False)]
    assert answer["steps"][0]["text"] == "block: grain column sid is not one of its columns"

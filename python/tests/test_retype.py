"""Tests for the retype check (docs/slice-10.md, slice 10d): <venv>/bin/python -m pytest python/tests"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from test_include import commit_all

import analysis_sql as sql_

ENTRY = """description: Sessions by entry date.
columns:
  - {name: session_id, type: bigint, description: The session.}
definitions:
  - name: client_entry
    kind: filter
    description: Sessions that entered the client survey.
    sql: lk_responsestatusid = 3
  - name: returned_share
    kind: metric
    description: Share of sessions returned.
    sql: avg(CASE WHEN is_returned THEN 1 ELSE 0 END)
"""

BLOCK = """/*---
description: Sessions with their buyer.
parameters:
  start: date
block:
  grain: [session_id]
  columns:
    session_id: the session
    buyer: the buyer's name
---*/
-- grain: session_id
SELECT s.session_id, b.name AS buyer
FROM cint.mkt.vw_sessions_lc_by_entrydate s
-- join: many:1 on buyer_id
JOIN cint.mkt.buyers b ON b.buyer_id = s.buyer_id
WHERE s.day >= :start
"""


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "trusted").mkdir()
    (tmp_path / "dictionaries").mkdir()
    (tmp_path / "dictionaries" / "cint.mkt.vw_sessions_lc_by_entrydate.yaml").write_text(ENTRY)
    (tmp_path / "trusted" / "sessions_with_buyer.sql").write_text(BLOCK)
    commit_all(tmp_path)
    return tmp_path


def warnings(root: Path, sql: str, dialect: str = "databricks") -> list[str]:
    return sql_.retype(sql, dialect, root)["warnings"]


@pytest.mark.parametrize(
    ("sql", "alias"),
    [
        (
            "SELECT count(*) FROM vw_sessions_lc_by_entrydate WHERE lk_responsestatusid = 3",
            "vw_sessions_lc_by_entrydate",
        ),
        (
            "SELECT count(*) FROM cint.mkt.vw_sessions_lc_by_entrydate s WHERE s.day > '2026-11-03' AND "
            "3 = s.lk_responsestatusid",
            "s",
        ),
        (
            "SELECT count(*) FROM buyers b JOIN mkt.vw_sessions_lc_by_entrydate s ON s.buyer_id = b.id "
            "AND s.lk_responsestatusid = 3",
            "s",
        ),
    ],
)
def test_the_client_entry_filter_written_out_is_flagged(root: Path, sql: str, alias: str) -> None:
    assert warnings(root, sql) == [
        "retypes cint.mkt.vw_sessions_lc_by_entrydate:client_entry (lk_responsestatusid = 3): include "
        f"{{{{ client_entry({alias}) }}}}"
    ]


def test_not_flagged_when_included_silenced_or_different(root: Path) -> None:
    written = "SELECT count(*) FROM vw_sessions_lc_by_entrydate s WHERE {{ client_entry(s) }}"
    expanded = sql_.expand(written, "databricks", root)
    assert expanded["retype_sql"] == "SELECT count(*) FROM vw_sessions_lc_by_entrydate s WHERE TRUE"
    assert warnings(root, expanded["retype_sql"]) == []
    assert (
        warnings(
            root,
            "-- retype: client_entry: status 3 before the 2026 recode means something else\n"
            "SELECT count(*) FROM vw_sessions_lc_by_entrydate WHERE lk_responsestatusid = 3",
        )
        == []
    )
    assert warnings(root, "SELECT count(*) FROM vw_sessions_lc_by_entrydate WHERE lk_responsestatusid = 4") == []
    # The same predicate on another table is that table's business.
    assert warnings(root, "SELECT count(*) FROM other_sessions WHERE lk_responsestatusid = 3") == []
    # A column of another source in the same SELECT is not the definition's.
    assert (
        warnings(
            root,
            "SELECT count(*) FROM vw_sessions_lc_by_entrydate s JOIN other o ON o.id = s.id WHERE "
            "o.lk_responsestatusid = 3",
        )
        == []
    )


def test_a_metric_written_out_is_flagged(root: Path) -> None:
    sql = (
        "SELECT buyer_id, AVG(CASE WHEN is_returned THEN 1 ELSE 0 END) AS share "
        "FROM vw_sessions_lc_by_entrydate GROUP BY buyer_id"
    )
    assert warnings(root, sql) == [
        "retypes cint.mkt.vw_sessions_lc_by_entrydate:returned_share (AVG(CASE WHEN is_returned THEN 1 "
        "ELSE 0 END)): include {{ returned_share(vw_sessions_lc_by_entrydate) }}"
    ]


def test_a_blocks_join_written_out_is_flagged_and_other_keys_are_not(root: Path) -> None:
    sql = (
        "SELECT x.session_id, y.name FROM vw_sessions_lc_by_entrydate x "
        "JOIN cint.mkt.buyers y ON x.buyer_id = y.buyer_id"
    )
    assert warnings(root, sql) == [
        "retypes block sessions_with_buyer (the join of buyers and vw_sessions_lc_by_entrydate on "
        "buyer_id): include {{ sessions_with_buyer(start => ...) }} as a CTE"
    ]
    assert warnings(root, "SELECT * FROM vw_sessions_lc_by_entrydate x JOIN buyers y ON x.seller_id = y.buyer_id") == []
    assert warnings(root, "-- retype: sessions_with_buyer: needs every session, not one start day\n" + sql) == []
    # The block's own stub, as the retype SQL holds it, is not a retype.
    included = sql_.expand(
        "WITH\n-- grain: session_id\nsb AS ({{ sessions_with_buyer('2026-11-01') }})\n-- grain: session_id\n"
        "SELECT * FROM sb",
        "databricks",
        root,
    )
    assert warnings(root, included["retype_sql"]) == []


def test_postgres_and_the_command(
    root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert (
        len(
            warnings(root, "SELECT count(*) FROM vw_sessions_lc_by_entrydate WHERE lk_responsestatusid = 3", "postgres")
        )
        == 1
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO("SELECT 1"))
    assert sql_.main(["retype", "databricks", str(root)]) == 0
    assert json.loads(capsys.readouterr().out) == {"warnings": []}

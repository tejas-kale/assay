"""The edges of the SQL rules, the steps, include by name and the retype check: each case as said today."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from test_include import commit_all

import analysis_include as include
import analysis_retype as retyping
import analysis_sql as sql_

PYTHON = Path(sys.executable)


def errors(sql: str) -> list[str]:
    return sql_.lint(sql)["errors"]


def joins(sql: str) -> list[dict[str, Any]]:
    """The joins of the first step of ``sql``."""
    return sql_.steps(sql)["steps"][0].get("joins", [])


def one_join(on: str, source: str = "a l") -> str:
    """A one-CTE query whose CTE joins ``b`` with ``on``."""
    cte = f"left_rows AS (SELECT id FROM {source}\n-- join: 1:1 on id\n{on})"
    return f"WITH\n-- grain: id\n{cte}\n-- grain: id\nSELECT id FROM left_rows"


# ---------------------------------------------------------------------------
# The SQL rules.


def test_a_grain_line_without_a_column_is_rejected() -> None:
    assert errors("WITH\n-- grain: ,\nnums AS (SELECT a FROM t)\n-- grain: a\nSELECT a FROM nums") == [
        'CTE nums: the "-- grain:" line names no column; give the columns that identify one row, or none.',
    ]


def test_a_set_operation_of_subqueries_is_read_by_its_first_select() -> None:
    sql = "WITH\n-- grain: a\nnums AS ((SELECT b FROM t) UNION ALL (SELECT b FROM u))\n-- grain: a\nSELECT a FROM nums"
    assert errors(sql) == ["CTE nums: grain a is not one of its output columns (b)."]


def test_an_insert_has_no_output_columns_to_check() -> None:
    assert errors("-- grain: z\nINSERT INTO t SELECT a FROM x\n-- join: 1:1 on a\nJOIN y ON x.a = y.a") == []


def test_a_window_function_alone_does_not_aggregate() -> None:
    sql = (
        "WITH\n-- grain: s\nshares AS (\n"
        "SELECT SUM(x) OVER () AS s FROM t WHERE x > 1)\n-- grain: s\nSELECT s FROM shares"
    )
    assert sql_.lint(sql) == {"errors": [], "warnings": []}


def test_a_join_on_something_unnamed_is_labelled_by_its_sql() -> None:
    assert errors("-- grain: a\nSELECT a FROM t CROSS JOIN (VALUES (1))") == [
        'Final SELECT, JOIN VALUES (1): no "-- join:" line above it. For a CROSS JOIN: "-- join: many:many on none".',
    ]


def test_an_aggregate_without_group_by_counts_as_aggregating() -> None:
    sql = "WITH\n-- grain: n\ncounted AS (SELECT COUNT(*) AS n FROM t WHERE x > 1)\n-- grain: n\nSELECT n FROM counted"
    warning = "CTE counted: filters and aggregates; do one of filter, join, aggregate per CTE."
    assert sql_.lint(sql)["warnings"] == [warning]


def test_an_aggregate_in_a_subquery_is_not_fed_by_the_outer_join() -> None:
    sql = (
        "-- grain: id\nSELECT a.id, (SELECT SUM(x) FROM c) AS total FROM a\n"
        "-- join: 1:many on id\nJOIN b ON a.id = b.id"
    )
    assert sql_.lint(sql)["warnings"] == []


def test_empty_statements_are_skipped() -> None:
    assert sql_.lint("SELECT 1;;") == {"errors": [], "warnings": []}


@pytest.mark.parametrize("call", [sql_.lint, sql_.lineage, sql_.steps])
def test_an_unknown_dialect_is_refused(call: Any) -> None:
    with pytest.raises(ValueError, match="dialect 'mysql' is not one of databricks, postgres"):
        call("SELECT 1", "mysql")


def test_the_lineage_of_nothing_says_so() -> None:
    assert sql_.lineage(";") == {"nodes": [], "edges": [], "note": "There is no statement."}


# ---------------------------------------------------------------------------
# The steps.


def test_a_cte_read_twice_is_written_once() -> None:
    sql = (
        "WITH\n-- grain: id\nbase_rows AS (SELECT id FROM a),\n-- grain: id\nleft_rows AS (SELECT id FROM base_rows),\n"
        "-- grain: id\nright_rows AS (SELECT id FROM base_rows),\n"
        "-- grain: id\nboth_rows AS (SELECT l.id FROM left_rows l\n"
        "-- join: 1:1 on id\nJOIN right_rows r ON (l.id = r.id))\nSELECT id FROM both_rows"
    )
    both = sql_.steps(sql)["steps"][3]
    assert both["counts"].count("base_rows AS (") == 1
    assert both["joins"] == [{"j": 1, "source": "right_rows", "declared": "1:1", "keys": ["id"]}]
    assert "assay_j1_left_keys" in both["counts"]


def test_a_join_using_its_keys_is_checked() -> None:
    step = sql_.steps(one_join("JOIN b USING (id)"))["steps"][0]
    assert step["joins"] == [{"j": 1, "source": "b", "declared": "1:1", "keys": ["id"]}]
    assert "(SELECT COUNT(*) FROM (SELECT DISTINCT id FROM b) AS assay_d) AS assay_j1_right_keys" in step["counts"]


UNQUALIFIED = "a column in the ON is not qualified by a table or alias of this SELECT"


@pytest.mark.parametrize(
    ("on", "source", "reason"),
    [
        ("JOIN (SELECT id FROM b) bb ON bb.id = l.id", "a l", "the joined source is a subquery"),
        ("JOIN b ON l.id = l.id", "a l", "each equality must compare the joined source with one other source"),
        ("JOIN b ON id = b.id", "a l", UNQUALIFIED),
        ("JOIN b ON l.id = b.id AND c.id = b.id", "a l", UNQUALIFIED),
        ("JOIN b ON l.id = b.id AND l.x > 1", "a l", "the ON is not an AND of column equalities"),
        ("JOIN b ON l.id = b.id AND m.id = b.id", "a l, m", "the ON reads more than two sources"),
    ],
)
def test_a_join_that_cannot_be_checked_says_why(on: str, source: str, reason: str) -> None:
    join = joins(one_join(on, source))[-1]
    assert join["checked"] is False
    assert join["reason"] == reason


def test_using_after_an_earlier_join_is_not_checked() -> None:
    sql = one_join("JOIN b ON a.id = b.id\n-- join: 1:1 on id\nJOIN c USING (id)", source="a")
    first, second = joins(sql)
    assert "checked" not in first
    assert second["reason"] == "USING is read only when the SELECT has one FROM source and no earlier join"


# ---------------------------------------------------------------------------
# Include by name.

BLOCK = """/*---
description: Sessions with a flag, a limit, a share and a label.
parameters:
  flag: boolean
  limit_to: integer
  share: number
  label: string
  start: {type: date, default: null}
block:
  grain: [session_id]
  columns:
    session_id: the session
---*/
-- grain: session_id
SELECT s.session_id FROM cint.mkt.sessions s
WHERE s.flag = :flag AND s.n < :limit_to AND s.share > :share AND s.label = :label AND s.day >= :start
"""

JOINLESS = """/*---
description: Every session.
parameters: {}
block:
  grain: [session_id]
  columns:
    session_id: the session
---*/
-- grain: session_id
SELECT session_id FROM cint.mkt.sessions
"""

NESTED = """/*---
description: Sessions with their buyer, through a CTE.
parameters: {}
block:
  grain: [session_id]
  columns:
    session_id: the session
---*/
WITH
-- grain: session_id
picked AS (SELECT session_id, buyer_id FROM cint.mkt.sessions)
-- grain: session_id
SELECT p.session_id FROM picked p
-- join: many:1 on buyer_id
JOIN cint.mkt.buyers b ON b.buyer_id = p.buyer_id
"""

BROKEN = """/*---
description: Includes a block, which a block may not.
parameters: {}
block:
  grain: [session_id]
  columns:
    session_id: the session
---*/
SELECT session_id FROM ({{ every_session() }})
"""

ENTRY = """description: Sessions.
columns:
  - {name: session_id, type: bigint, description: The session.}
definitions:
  - name: is_complete
    kind: filter
    description: Completes.
    sql: s.status = 1 AND kind = 2
  - name: unparsable
    kind: filter
    description: Not SQL.
    sql: "status = = ("
"""


SELF_JOIN = """/*---
description: Sessions joined with themselves, and with a table by an unknown alias.
parameters: {}
block:
  grain: [session_id]
  columns:
    session_id: the session
---*/
SELECT a.session_id FROM cint.mkt.sessions a
-- join: 1:1 on session_id
JOIN cint.mkt.sessions b ON a.session_id = b.session_id
-- join: 1:1 on session_id
JOIN cint.mkt.buyers c ON c.session_id = x.session_id
"""


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "trusted").mkdir()
    (tmp_path / "dictionaries").mkdir()
    (tmp_path / "trusted" / "flagged_sessions.sql").write_text(BLOCK)
    (tmp_path / "trusted" / "every_session.sql").write_text(JOINLESS)
    (tmp_path / "trusted" / "nested_sessions.sql").write_text(NESTED)
    (tmp_path / "trusted" / "broken_block.sql").write_text(BROKEN)
    (tmp_path / "trusted" / "self_joined.sql").write_text(SELF_JOIN)
    (tmp_path / "dictionaries" / "cint.mkt.sessions.yaml").write_text(ENTRY)
    commit_all(tmp_path)
    return tmp_path


def expanded(root: Path, call: str) -> dict[str, Any]:
    return sql_.expand(f"WITH\n-- grain: session_id\npicked AS ({call})\nSELECT * FROM picked", "databricks", root)


def test_block_arguments_take_booleans_numbers_and_strings_and_a_default_of_null(root: Path) -> None:
    found = expanded(root, "{{ flagged_sessions(true, 5, 1.5, 'it''s') }}")
    assert "errors" not in found, found
    assert "s.flag = TRUE AND s.n < 5 AND s.share > 1.5 AND s.label = 'it\\'s'" in found["sql"]


def test_a_null_argument_is_checked_against_its_type(root: Path) -> None:
    call = "{{ flagged_sessions(true, 5, 1.5, 'x', null) }}"
    assert expanded(root, call)["errors"][0].startswith(f"{call}: argument start must be a date;")


def test_block_arguments_take_false_and_named_values(root: Path) -> None:
    found = expanded(root, "{{ flagged_sessions(false, 5, 2, 'x', start => '2026-11-01') }}")
    assert "s.flag = FALSE" in found["sql"]
    assert "s.day >= CAST('2026-11-01' AS DATE)" in found["sql"]


@pytest.mark.parametrize(
    ("args", "problem"),
    [
        ("flag => true, 5", "a positional argument after a named one"),
        ("true, 5, 1, 'x', null, 7", "takes 5 arguments"),
        ("true, 5, 1, x", "'x' is not a literal: quote strings and dates ('2026-11-01')"),
    ],
)
def test_bad_block_arguments_are_named(root: Path, args: str, problem: str) -> None:
    found = expanded(root, f"{{{{ flagged_sessions({args}) }}}}")
    signature = "flagged_sessions(flag: boolean, limit_to: integer, share: number, label: string, start?: date)"
    assert found == {"errors": [f"{{{{ flagged_sessions({args}) }}}}: {problem}; {signature}."]}


def test_a_qualified_column_in_a_definition_keeps_its_table(root: Path) -> None:
    found = sql_.expand("SELECT 1 FROM cint.mkt.sessions t WHERE {{ is_complete(t) }}", "databricks", root)
    assert found["sql"] == "SELECT 1 FROM cint.mkt.sessions t WHERE (s.status = 1 AND t.kind = 2)"


def test_a_definition_changed_since_its_commit_is_not_trusted(root: Path) -> None:
    (root / "dictionaries" / "cint.mkt.sessions.yaml").write_text(ENTRY.replace("Completes.", "Completed."))
    found = sql_.expand("SELECT 1 FROM cint.mkt.sessions t WHERE {{ is_complete(t) }}", "databricks", root)
    assert found == {
        "errors": [
            "cint.mkt.sessions:is_complete differs from its last commit, or was never committed: "
            "it is not trusted until the user approves it again",
        ],
    }


def test_expand_refuses_an_unknown_dialect(root: Path) -> None:
    with pytest.raises(ValueError, match="dialect 'mysql'"):
        sql_.expand("SELECT 1", "mysql", root)


# ---------------------------------------------------------------------------
# The retype check.


def test_retype_of_nothing_warns_of_nothing(root: Path) -> None:
    assert sql_.retype(";", "databricks", root) == {"warnings": []}


def test_retype_skips_definitions_that_do_not_parse_and_blocks_without_a_join_between_two_tables(root: Path) -> None:
    assert sql_.retype("SELECT session_id FROM cint.mkt.sessions", "databricks", root) == {"warnings": []}


def test_retype_finds_a_join_below_a_cte_and_skips_a_changed_block(root: Path) -> None:
    sql = "SELECT p.session_id FROM picked p JOIN cint.mkt.buyers b ON b.buyer_id = p.buyer_id"
    said = "the join of buyers and picked on buyer_id"
    assert sql_.retype(sql, "databricks", root) == {
        "warnings": [f"retypes block nested_sessions ({said}): include {{{{ nested_sessions() }}}} as a CTE"],
    }
    (root / "trusted" / "nested_sessions.sql").write_text(NESTED + "\n")
    assert sql_.retype(sql, "databricks", root) == {"warnings": []}


def test_retype_skips_a_block_whose_body_fails_to_expand(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("broken")

    pieces = include.Pieces(root)
    monkeypatch.setattr(retyping, "expand_with", broken)
    sql = "SELECT p.session_id FROM cint.mkt.sessions p JOIN cint.mkt.buyers b ON b.buyer_id = p.buyer_id"
    assert sql_.retype(sql, "databricks", root, pieces) == {"warnings": []}


# ---------------------------------------------------------------------------
# The command line.


def run(*args: str) -> tuple[int, dict[str, Any]]:
    command = [PYTHON, "-m", "analysis_sql", *args]
    here = Path(sql_.__file__).parent
    done = subprocess.run(command, input="", capture_output=True, text=True, check=False, cwd=here)
    return done.returncode, json.loads(done.stdout)


def test_the_command_says_its_usage() -> None:
    code, answer = run("nonsense")
    assert code == 1
    assert answer["error"].startswith("usage: python -m analysis_sql lint")
    assert answer["error"].endswith("got: ['nonsense']")


def test_the_command_reports_any_failure(capsys: pytest.CaptureFixture[str]) -> None:
    assert sql_.main(["lint", "mysql", "/no/such/file.sql"]) == 1
    missing = "FileNotFoundError: [Errno 2] No such file or directory: '/no/such/file.sql'"
    assert json.loads(capsys.readouterr().out) == {"error": missing}

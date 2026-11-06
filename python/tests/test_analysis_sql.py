"""Tests for analysis_sql, the SQL rules: <venv>/bin/python -m pytest python/tests"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analysis_sql as sql_rules  # noqa: E402

GOOD = """
WITH
-- grain: customer_id, order_date
daily_spend AS (
  SELECT o.customer_id, o.order_date, SUM(o.amount) AS spend
  FROM orders o
  GROUP BY o.customer_id, o.order_date
),
-- grain: customer_id
customers_named AS (
  SELECT c.customer_id, c.name FROM customers c
)
-- grain: customer_id, order_date
SELECT s.customer_id, s.order_date, n.name, s.spend
FROM daily_spend s
-- join: many:1 on customer_id
JOIN customers_named n ON n.customer_id = s.customer_id
"""


def lint(text: str, dialect: str = "databricks") -> dict[str, list[str]]:
    return sql_rules.lint(text, dialect)


@pytest.mark.parametrize("dialect", ["databricks", "postgres"])
def test_a_commented_multi_cte_query_passes(dialect: str) -> None:
    assert lint(GOOD, dialect) == {"errors": [], "warnings": []}


@pytest.mark.parametrize("dialect", ["databricks", "postgres"])
def test_a_plain_one_table_query_is_not_checked(dialect: str) -> None:
    assert lint("SELECT id, name FROM t WHERE id > 3", dialect) == {"errors": [], "warnings": []}


def test_scalar_and_in_subqueries_stay_allowed() -> None:
    text = """
    -- grain: id
    SELECT id, (SELECT max(day) FROM days) AS last_day FROM t
    -- join: 1:1 on id
    JOIN u ON u.id = t.id
    WHERE t.id IN (SELECT id FROM wanted) AND EXISTS (SELECT 1 FROM v WHERE v.id = t.id)
    """
    assert lint(text) == {"errors": [], "warnings": []}


def test_a_cte_without_grain_and_a_cryptic_name_are_rejected() -> None:
    text = """
    WITH ow AS (SELECT customer_id FROM orders)
    -- grain: customer_id
    SELECT customer_id FROM ow
    """
    assert lint(text)["errors"] == ['CTE ow: no "-- grain:" line above it.', "CTE ow: name too short; say what it holds."]


@pytest.mark.parametrize("name", ["step1", "cte_2", "temp", "tmp_3", "sub1", "q_12"])
def test_names_that_say_what_a_cte_does_are_rejected(name: str) -> None:
    text = f"""
    WITH
    -- grain: id
    {name} AS (SELECT id FROM t)
    -- grain: id
    SELECT id FROM {name}
    """
    errors = lint(text)["errors"]
    assert len(errors) == 1 and errors[0].startswith(f"CTE {name}: name")


def test_a_grain_column_that_is_not_an_output_column_is_rejected() -> None:
    text = """
    WITH
    -- grain: customer_id, order_day
    daily_spend AS (SELECT customer_id, order_date, SUM(amount) AS spend FROM orders GROUP BY 1, 2)
    -- grain: customer_id
    SELECT customer_id FROM daily_spend
    """
    assert lint(text)["errors"] == ["CTE daily_spend: grain order_day is not one of its output columns (customer_id, order_date, spend)."]


def test_grain_none_a_column_list_and_star_are_accepted() -> None:
    text = """
    WITH
    -- grain: a
    pairs_of_values(a, b) AS (SELECT 1, 2 UNION ALL SELECT 3, 4),
    -- grain: whatever
    everything_in_t AS (SELECT * FROM t)
    -- grain: none
    SELECT COUNT(*) AS n FROM pairs_of_values
    """
    assert lint(text)["errors"] == []


def test_the_final_select_needs_a_grain_line() -> None:
    text = """
    SELECT t.id, u.name FROM t
    -- join: 1:1 on id
    JOIN u ON u.id = t.id
    """
    assert lint(text)["errors"] == ['Final SELECT: no "-- grain:" line above it.']


def test_a_join_without_a_join_line_is_rejected_and_named_by_its_line() -> None:
    text = """-- grain: id
SELECT t.id FROM t
JOIN u ON u.id = t.id
"""
    assert lint(text)["errors"] == ['Final SELECT, JOIN u (line 3): no "-- join:" line above it.']


def test_a_cross_join_needs_its_line_too() -> None:
    text = """-- grain: id, day
SELECT t.id, d.day FROM t
CROSS JOIN days d
"""
    assert lint(text)["errors"] == ['Final SELECT, JOIN days (line 3): no "-- join:" line above it. For a CROSS JOIN: "-- join: many:many on none".']
    fixed = text.replace("CROSS JOIN", "-- join: many:many on none\nCROSS JOIN")
    assert lint(fixed)["errors"] == []


def test_a_malformed_join_line_is_rejected() -> None:
    text = """-- grain: id
SELECT t.id FROM t
-- join: one to many
JOIN u ON u.id = t.id
"""
    assert lint(text)["errors"] == ['Final SELECT, JOIN u (line 4): the "-- join:" line reads "one to many"; write "-- join: <1:1|1:many|many:1|many:many> on <key>[, <key>...]".']


@pytest.mark.parametrize("dialect", ["databricks", "postgres"])
def test_a_subquery_in_from_or_join_must_be_a_cte(dialect: str) -> None:
    text = """-- grain: id
SELECT x.id FROM (SELECT id FROM t) x
-- join: 1:1 on id
JOIN (SELECT id FROM u) y ON y.id = x.id
"""
    assert lint(text, dialect)["errors"] == [
        "Final SELECT: subquery in FROM (line 2); make it a CTE.",
        "Final SELECT: subquery in JOIN (line 4); make it a CTE.",
    ]


def test_a_cte_that_joins_and_aggregates_is_a_warning() -> None:
    text = """
    WITH
    -- grain: customer_id
    spend_per_customer AS (
      SELECT o.customer_id, MAX(l.amount) AS biggest
      FROM orders o
      -- join: many:1 on customer_id
      JOIN customers c ON c.customer_id = o.customer_id
      WHERE c.active
      GROUP BY o.customer_id
    )
    -- grain: customer_id
    SELECT customer_id FROM spend_per_customer
    """
    assert lint(text) == {"errors": [], "warnings": ["CTE spend_per_customer: filters and joins and aggregates; do one of filter, join, aggregate per CTE."]}


def test_a_where_on_a_single_source_cte_is_just_the_filter_job() -> None:
    text = """
    WITH
    -- grain: id
    active_customers AS (SELECT id FROM customers WHERE active)
    -- grain: id
    SELECT id FROM active_customers
    """
    assert lint(text) == {"errors": [], "warnings": []}


def test_a_many_side_join_feeding_a_sum_is_a_warning() -> None:
    text = """-- grain: customer_id
SELECT o.customer_id, SUM(o.amount) AS spend
FROM orders o
-- join: 1:many on order_id
JOIN order_lines l ON l.order_id = o.order_id
GROUP BY o.customer_id
"""
    assert lint(text)["warnings"] == ["Final SELECT, JOIN order_lines (line 5): a 1:many join feeds SUM in the same SELECT; aggregate before joining."]
    assert lint(text.replace("1:many", "many:1"))["warnings"] == []


def test_the_command_reads_stdin_and_prints_json(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("WITH ow AS (SELECT 1 AS x) SELECT x FROM ow"))
    assert sql_rules.main(["lint", "postgres"]) == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["errors"][0] == 'CTE ow: no "-- grain:" line above it.'


def test_the_command_says_when_the_sql_does_not_parse(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("SELECT * FROM ("))
    assert sql_rules.main(["lint", "databricks"]) == 1
    assert json.loads(capsys.readouterr().out)["error"].startswith("the SQL does not parse")


def test_template_parameters_bind_to_dummies_but_casts_stay() -> None:
    assert sql_rules.bind_dummies("SELECT a::int FROM t WHERE d >= :start AND s = '12:30'") == "SELECT a::int FROM t WHERE d >= NULL AND s = '12:30'"


SPEC_EXAMPLE = """
WITH
-- grain: customer_id, order_date
daily_spend AS (
  SELECT o.customer_id, o.order_date, SUM(l.amount) AS spend
  FROM shop.sales.orders o
  -- join: 1:many on order_id
  JOIN shop.sales.order_lines l ON l.order_id = o.order_id
  GROUP BY o.customer_id, o.order_date
)
-- grain: none
SELECT SUM(spend) FROM daily_spend
"""


def lineage(text: str, dialect: str = "databricks", template: bool = False) -> dict:
    return sql_rules.lineage(text, dialect, template)


def edge(found: dict, source: str, target: str) -> list[dict]:
    return [e for e in found["edges"] if e["from"] == source and e["to"] == target]


@pytest.mark.parametrize("dialect", ["databricks", "postgres"])
def test_lineage_of_the_spec_example(dialect: str) -> None:
    assert lineage(SPEC_EXAMPLE, dialect) == {
        "nodes": [
            {"id": "shop.sales.orders", "kind": "table", "name": "shop.sales.orders"},
            {"id": "shop.sales.order_lines", "kind": "table", "name": "shop.sales.order_lines"},
            {"id": "daily_spend", "kind": "cte", "name": "daily_spend", "grain": ["customer_id", "order_date"]},
            {"id": "final", "kind": "final", "name": "Final SELECT", "grain": []},
        ],
        "edges": [
            {"from": "shop.sales.orders", "to": "daily_spend"},
            {"from": "shop.sales.order_lines", "to": "daily_spend", "join": {"cardinality": "1:many", "keys": ["order_id"]}},
            {"from": "daily_spend", "to": "final"},
        ],
    }


def test_a_table_used_in_two_ctes_is_one_node() -> None:
    found = lineage("WITH\n-- grain: a\nfirst_cte AS (SELECT a FROM Orders),\n-- grain: a\nsecond_cte AS (SELECT a FROM orders)\nSELECT 1 FROM first_cte")
    assert [n["id"] for n in found["nodes"] if n["kind"] == "table"] == ["orders"]
    assert edge(found, "orders", "first_cte") and edge(found, "orders", "second_cte")


def test_two_joins_of_one_table_give_two_edges_and_a_missing_line_gives_empty_join() -> None:
    found = lineage("SELECT 1 FROM a\n-- join: many:1 on x\nJOIN b ON 1=1\nJOIN b b2 ON 1=1")
    assert edge(found, "b", "final") == [{"from": "b", "to": "final", "join": {"cardinality": "many:1", "keys": ["x"]}}, {"from": "b", "to": "final", "join": {}}]
    assert edge(found, "a", "final") == [{"from": "a", "to": "final"}]


def test_grain_is_absent_empty_or_columns() -> None:
    found = lineage("WITH\nplain AS (SELECT 1 FROM t),\n-- grain: none\ntotal AS (SELECT 1 FROM t),\n-- grain: `a`, B\nkeyed AS (SELECT 1 FROM t)\nSELECT 1 FROM plain")
    nodes = {n["id"]: n for n in found["nodes"]}
    assert "grain" not in nodes["plain"] and "grain" not in nodes["final"]
    assert nodes["total"]["grain"] == [] and nodes["keyed"]["grain"] == ["a", "b"]


def test_a_subquery_table_is_an_edge_without_join() -> None:
    found = lineage("SELECT 1 FROM a WHERE id IN (SELECT id FROM b) AND EXISTS (SELECT 1 FROM c)")
    assert edge(found, "b", "final") == [{"from": "b", "to": "final"}]
    assert edge(found, "c", "final") == [{"from": "c", "to": "final"}]


def test_a_cte_named_final_leaves_the_id_to_the_cte() -> None:
    found = lineage("WITH final AS (SELECT 1 FROM t) SELECT 1 FROM final")
    assert [(n["id"], n["kind"]) for n in found["nodes"]] == [("t", "table"), ("final", "cte"), ("final_select", "final")]
    assert edge(found, "final", "final_select")


def test_only_the_last_statement_is_read_and_a_note_says_so() -> None:
    found = lineage("SELECT 1 FROM a; SELECT 1 FROM b")
    assert [n["id"] for n in found["nodes"]] == ["b", "final"]
    assert "note" in found


def test_template_binds_placeholders() -> None:
    assert lineage("SELECT 1 FROM t WHERE d > :since", template=True)["nodes"][0]["id"] == "t"


def test_lineage_command_prints_json_and_a_parse_error(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("SELECT 1 FROM t WHERE d > :since"))
    assert sql_rules.main(["lineage", "postgres", "--template"]) == 0
    assert json.loads(capsys.readouterr().out)["nodes"][0]["id"] == "t"
    monkeypatch.setattr(sys, "stdin", io.StringIO("SELECT FROM WHERE ("))
    assert sql_rules.main(["lineage", "databricks"]) == 1
    assert "does not parse" in json.loads(capsys.readouterr().out)["error"]

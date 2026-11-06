"""Tests for analysis_sql, the SQL rules: <venv>/bin/python -m pytest python/tests"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest
import sqlglot

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


CTE_BODY = """WITH
-- grain: customer_id
spend_per_customer AS (SELECT customer_id, SUM(amount) AS spend FROM orders GROUP BY customer_id)
{final_grain}SELECT s.customer_id, s.spend FROM spend_per_customer s
"""

JOIN_BODY = """{final_grain}SELECT c.customer_id, n.name FROM customers c
-- join: 1:1 on customer_id
JOIN names n ON n.customer_id = c.customer_id
"""

CREATE_AS = {
    "create view with": "CREATE VIEW spend_view AS\n" + CTE_BODY,
    "create or replace view with": "CREATE OR REPLACE VIEW spend_view AS\n" + CTE_BODY,
    "create or replace temporary view with": "CREATE OR REPLACE TEMPORARY VIEW spend_view AS\n" + CTE_BODY,
    "create or replace table with": "CREATE OR REPLACE TABLE spend_table AS\n" + CTE_BODY,
    "create view, no with, join": "CREATE VIEW names_view AS\n" + JOIN_BODY,
    "comments between as and with": "CREATE OR REPLACE VIEW spend_view AS\n-- spend per customer, rebuilt nightly\n-- owner: analytics\n" + CTE_BODY,
}
FINAL_GRAIN = "-- grain: customer_id\n"


@pytest.mark.parametrize("dialect", ["databricks", "postgres"])
@pytest.mark.parametrize("name", list(CREATE_AS))
def test_create_as_reads_the_grain_above_its_final_select(name: str, dialect: str) -> None:
    text = CREATE_AS[name].format(final_grain=FINAL_GRAIN)
    if dialect == "postgres" and "TABLE" in text:
        text = text.replace("CREATE OR REPLACE TABLE", "CREATE TABLE")
    assert lint(text, dialect) == {"errors": [], "warnings": []}


@pytest.mark.parametrize("dialect", ["databricks", "postgres"])
@pytest.mark.parametrize("name", list(CREATE_AS))
def test_create_as_without_a_final_grain_line_is_rejected(name: str, dialect: str) -> None:
    text = CREATE_AS[name].format(final_grain="")
    if dialect == "postgres" and "TABLE" in text:
        text = text.replace("CREATE OR REPLACE TABLE", "CREATE TABLE")
    assert lint(text, dialect)["errors"] == ['Final SELECT: no "-- grain:" line above it.']


def test_create_as_checks_the_final_grain_against_its_output_columns() -> None:
    text = CREATE_AS["create view with"].format(final_grain="-- grain: customer_key\n")
    assert lint(text)["errors"] == ["Final SELECT: grain customer_key is not one of its output columns (customer_id, spend)."]


def test_a_grain_line_above_create_does_not_count_for_the_final_select() -> None:
    text = FINAL_GRAIN + CREATE_AS["create view with"].format(final_grain="")
    assert lint(text)["errors"] == ['Final SELECT: no "-- grain:" line above it.']


def test_a_scalar_subquery_in_the_final_where_still_passes() -> None:
    text = """
    WITH
    -- grain: probe_id
    probes_scored AS (SELECT probe_id, score FROM probes)
    -- grain: probe_id
    SELECT p.probe_id, p.score FROM probes_scored p
    WHERE p.score >= (SELECT pool_floor FROM probe_constants)
    """
    assert lint(text) == {"errors": [], "warnings": []}
    assert lint("CREATE VIEW probes_view AS\n" + text) == {"errors": [], "warnings": []}


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


THREE = """
WITH
-- grain: order_id
base_orders AS (SELECT order_id, customer_id FROM orders),
-- grain: customer_id
unrelated_totals AS (SELECT customer_id FROM payments),
-- grain: customer_id
customer_orders AS (SELECT customer_id FROM base_orders)
-- grain: customer_id
SELECT customer_id FROM customer_orders
"""


def plan(text: str, dialect: str = "databricks", template: bool = False) -> dict:
    return sql_rules.steps(text, dialect, template)


def step(found: dict, name: str) -> dict:
    return next(s for s in found["steps"] if s["name"] == name)


def parses(text: str, dialect: str) -> None:
    assert sqlglot.parse_one(text, read=dialect) is not None


@pytest.mark.parametrize("dialect", ["databricks", "postgres"])
def test_steps_follow_the_written_order_and_each_with_holds_only_the_ctes_it_needs(dialect: str) -> None:
    found = plan(THREE, dialect)
    assert [(s["k"], s["name"]) for s in found["steps"]] == [(1, "base_orders"), (2, "unrelated_totals"), (3, "customer_orders"), (4, "final")]
    nodes = found["lineage"]["nodes"]
    assert [nodes[s["node"]]["id"] for s in found["steps"]] == ["base_orders", "unrelated_totals", "customer_orders", "final"]
    preview = step(found, "customer_orders")["preview"]
    assert preview.index("base_orders AS") < preview.index("customer_orders AS") and "unrelated_totals" not in preview and "payments" not in preview
    assert preview.endswith("SELECT * FROM customer_orders LIMIT 50")
    assert "base_orders AS" not in step(found, "unrelated_totals")["counts"]
    for each in found["steps"]:
        parses(each["counts"], dialect)
        if each["preview"]:
            parses(each["preview"], dialect)


def test_the_final_step_has_no_preview_and_counts_the_final_select_as_one_more_cte() -> None:
    final = step(plan(THREE), "final")
    assert final["preview"] is None
    assert "assay_final AS (SELECT customer_id FROM customer_orders)" in final["counts"]
    assert "payments" not in final["counts"] and "COUNT(*) FROM assay_final)" in final["counts"]
    assert final["grain"] == ["customer_id"]


def test_grain_counts_distinct_tuples_and_is_absent_for_none_star_and_no_line() -> None:
    sql = """WITH
-- grain: a, b
keyed AS (SELECT a, b FROM t),
-- grain: none
total AS (SELECT COUNT(*) AS n FROM t),
-- grain: a
everything AS (SELECT * FROM t),
plain AS (SELECT a FROM t)
SELECT 1 FROM keyed"""
    found = plan(sql)
    assert "SELECT DISTINCT a, b FROM keyed" in step(found, "keyed")["counts"] and "AS assay_grain_rows" in step(found, "keyed")["counts"]
    assert step(found, "keyed")["grain"] == ["a", "b"]
    assert step(found, "total")["grain"] == [] and "assay_grain_rows" not in step(found, "total")["counts"]
    assert "assay_grain_rows" not in step(found, "everything")["counts"]
    assert "grain" not in step(found, "plain") and "assay_grain_rows" not in step(found, "plain")["counts"]


JOINS = """WITH
-- grain: order_id
spend AS (
  SELECT o.order_id
  FROM shop.orders o
  -- join: 1:many on order_id
  JOIN shop.lines l ON l.order_id = o.order_id AND l.shop = o.shop
  -- join: many:1 on k
  JOIN dims USING (k)
  -- join: many:many on none
  CROSS JOIN other
  -- join: 1:1 on a
  JOIN third t ON t.a < o.a
  -- join: 1:1 on a
  JOIN fourth f ON f.a = o.a AND f.b = t.b
  JOIN bare ON bare.a = o.a
)
SELECT 1 FROM spend"""


@pytest.mark.parametrize("dialect", ["databricks", "postgres"])
def test_join_counts_name_each_side_by_the_on_columns(dialect: str) -> None:
    found = plan(JOINS, dialect)
    joins = step(found, "spend")["joins"]
    assert joins[0] == {"j": 1, "source": "lines", "declared": "1:many", "keys": ["order_id"]}
    counts = step(found, "spend")["counts"]
    for column in ("left_rows", "left_keys", "right_rows", "right_keys"):
        assert f"AS assay_j1_{column}" in counts
    assert "SELECT DISTINCT order_id, shop FROM shop.orders" in counts and "SELECT DISTINCT order_id, shop FROM shop.lines" in counts
    parses(counts, dialect)


def test_unchecked_joins_say_why_and_have_no_counts() -> None:
    joins = {j["j"]: j for j in step(plan(JOINS), "spend")["joins"]}
    assert joins[2]["source"] == "dims" and joins[2]["checked"] is False and "USING" in joins[2]["reason"]
    assert joins[3]["checked"] is False and "CROSS" in joins[3]["reason"]
    assert joins[4]["checked"] is False and "equalities" in joins[4]["reason"]
    assert joins[5]["checked"] is False and "more than two" in joins[5]["reason"]
    assert joins[6]["checked"] is False and "join:" in joins[6]["reason"] and "declared" not in joins[6]
    counts = step(plan(JOINS), "spend")["counts"]
    assert "assay_j3_" not in counts and "assay_j4_" not in counts and "assay_j5_" not in counts and "assay_j6_" not in counts


def test_using_is_read_only_for_the_first_join() -> None:
    later = plan("WITH\n-- grain: a\nx AS (SELECT 1 AS a FROM p\n-- join: 1:1 on a\nJOIN q ON q.a = p.a\n-- join: 1:1 on a\nJOIN r USING (a))\nSELECT 1 FROM x")
    first, second = step(later, "x")["joins"]
    assert "checked" not in first and second["checked"] is False and "USING" in second["reason"]


def test_final_select_joins_are_counted_too() -> None:
    found = plan("WITH\n-- grain: a\nx AS (SELECT a FROM p)\n-- grain: a\nSELECT x.a FROM x\n-- join: 1:1 on a\nJOIN y ON y.a = x.a")
    assert step(found, "final")["joins"][0]["declared"] == "1:1"
    assert "AS assay_j1_left_rows" in step(found, "final")["counts"]


def test_no_cte_a_recursive_cte_and_no_statement_give_no_steps_and_a_note() -> None:
    assert plan("SELECT 1 FROM t")["steps"] == [] and "note" in plan("SELECT 1 FROM t")
    recursive = plan("WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r")
    assert recursive["steps"] == [] and "recursive" in recursive["note"].lower()
    assert plan("")["steps"] == [] and "note" in plan("")


def test_a_set_operation_in_the_final_select_counts_rows_only_but_its_ctes_are_steps() -> None:
    found = plan("WITH\n-- grain: a\nx AS (SELECT a FROM p)\n-- grain: a\nSELECT a FROM x UNION ALL SELECT a FROM x")
    assert [s["name"] for s in found["steps"]] == ["x", "final"]
    assert "assay_grain_rows" not in step(found, "final")["counts"] and "grain" not in step(found, "final")
    assert "note" in found
    parses(step(found, "final")["counts"], "postgres")


def test_steps_with_template_bind_placeholders() -> None:
    found = plan("WITH\n-- grain: a\nx AS (SELECT a FROM t WHERE d > :since)\nSELECT a FROM x", template=True)
    assert "d > NULL" in step(found, "x")["preview"]


def test_the_last_statement_is_stepped() -> None:
    found = plan("WITH x AS (SELECT 1 FROM a) SELECT 1 FROM x; WITH y AS (SELECT 1 FROM b) SELECT 1 FROM y")
    assert [s["name"] for s in found["steps"]] == ["y", "final"] and "note" in found["lineage"]


def test_steps_command_prints_json_and_a_parse_error(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("WITH x AS (SELECT 1 FROM t WHERE d > :since) SELECT 1 FROM x"))
    assert sql_rules.main(["steps", "postgres", "--template"]) == 0
    assert [s["name"] for s in json.loads(capsys.readouterr().out)["steps"]] == ["x", "final"]
    monkeypatch.setattr(sys, "stdin", io.StringIO("SELECT FROM WHERE ("))
    assert sql_rules.main(["steps", "databricks"]) == 1
    assert "does not parse" in json.loads(capsys.readouterr().out)["error"]

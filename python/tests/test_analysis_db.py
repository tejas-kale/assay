"""Tests for analysis_db with the Databricks SDK and connector patched out: no network, no CLI."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analysis_db  # noqa: E402

HOST = "https://cint-prd-mkt.cloud.databricks.com"


class FakeConfig:
    """Stands for databricks.sdk.core.Config: records its arguments, never runs the CLI."""

    made: list[dict[str, str]] = []

    def __init__(self, **kwargs: str) -> None:
        FakeConfig.made.append(kwargs)
        self.host = HOST
        self.calls = 0

    def authenticate(self) -> dict[str, str]:
        self.calls += 1
        return {"Authorization": f"Bearer token-{self.calls}"}


@pytest.fixture
def connects(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Patches the SDK's Config and the connector's connect; returns the connect calls' keyword arguments."""
    import databricks.sdk.core
    import databricks.sql

    FakeConfig.made = []
    monkeypatch.setattr(databricks.sdk.core, "Config", FakeConfig)
    calls: list[dict] = []

    def connect(*args: object, **kwargs: object) -> object:
        calls.append(kwargs)
        raise ConnectionRefusedError("no network in tests")

    monkeypatch.setattr(databricks.sql, "connect", connect)
    return calls


def test_read_target_defaults_and_keys() -> None:
    assert analysis_db.read_target("") == {"profile": "Cint mkt", "warehouse": "455a178462311474"}
    text = "# Marks this folder for the analysis mod.\nProfile:  DEFAULT \nwarehouse: abc123\npg_database: x\n"
    assert analysis_db.read_target(text) == {"profile": "DEFAULT", "warehouse": "abc123"}


def test_read_target_from_analysis_yaml_drops_quotes_and_comments() -> None:
    text = 'title: Churn in Q3\nprofile: Cint mkt   # optional\nwarehouse: "w9"\n'
    assert analysis_db.read_target(text) == {"profile": "Cint mkt", "warehouse": "w9"}


def test_find_marker_is_the_nearest(tmp_path: Path) -> None:
    (tmp_path / "analysis.yaml").write_text("profile: outer\n")
    inner = tmp_path / "a" / "b"
    inner.mkdir(parents=True)
    assert analysis_db.find_marker(inner) == tmp_path / "analysis.yaml"
    (tmp_path / "a" / "analysis.yaml").write_text("profile: inner\n")
    assert analysis_db.find_marker(inner) == tmp_path / "a" / "analysis.yaml"


def test_find_marker_skips_a_folder_named_like_it(tmp_path: Path) -> None:
    (tmp_path / "analysis.yaml").mkdir()
    assert analysis_db.find_marker(tmp_path) is None


def test_engine_url_has_the_warehouse_path_and_no_credentials() -> None:
    assert analysis_db.engine_url(HOST, "w1") == "databricks://cint-prd-mkt.cloud.databricks.com?http_path=/sql/1.0/warehouses/w1"
    assert (
        analysis_db.engine_url("cint.example.com/", "w1", "main", "sales")
        == "databricks://cint.example.com?http_path=/sql/1.0/warehouses/w1&catalog=main&schema=sales"
    )


def test_engine_uses_the_marker_and_the_cli_login(tmp_path: Path, connects: list[dict]) -> None:
    (tmp_path / "analysis.yaml").write_text("profile: Other\nwarehouse: w42\n")
    engine = analysis_db.engine(tmp_path, catalog="main", schema="sales")

    assert FakeConfig.made == [{"profile": "Other", "auth_type": "databricks-cli"}]
    assert engine.dialect.name == "databricks"
    assert engine.url.host == "cint-prd-mkt.cloud.databricks.com"
    assert engine.url.password is None
    assert engine.url.query == {"http_path": "/sql/1.0/warehouses/w42", "catalog": "main", "schema": "sales"}
    assert engine.pool._pre_ping is True
    # Making the engine connects to nothing.
    assert connects == []


def test_a_connection_gets_the_credentials_provider_and_no_cloud_fetch_or_telemetry(tmp_path: Path, connects: list[dict]) -> None:
    (tmp_path / "analysis.yaml").write_text("")
    engine = analysis_db.engine(tmp_path)
    with pytest.raises(Exception, match="no network in tests"):
        engine.connect()

    [kwargs] = connects
    assert kwargs["server_hostname"] == "cint-prd-mkt.cloud.databricks.com"
    assert kwargs["http_path"] == "/sql/1.0/warehouses/455a178462311474"
    assert kwargs["access_token"] is None
    assert kwargs["use_cloud_fetch"] is False
    assert kwargs["enable_telemetry"] is False
    # The connector calls the provider for a header factory, then the factory for each request's headers:
    # the SDK's authenticate, which refreshes the token through the CLI as it nears expiry.
    headers = kwargs["credentials_provider"]()
    assert headers() == {"Authorization": "Bearer token-1"}
    assert headers() == {"Authorization": "Bearer token-2"}
    assert FakeConfig.made == [{"profile": "Cint mkt", "auth_type": "databricks-cli"}]


def test_without_a_marker_the_defaults_apply(tmp_path: Path, connects: list[dict]) -> None:
    engine = analysis_db.engine(tmp_path)
    assert engine.url.query["http_path"] == "/sql/1.0/warehouses/455a178462311474"
    assert FakeConfig.made[0]["profile"] == "Cint mkt"


def test_with_no_start_it_looks_from_the_working_directory(tmp_path: Path, connects: list[dict], monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "analysis.yaml").write_text("warehouse: here\n")
    nested = tmp_path / "lib"
    nested.mkdir()
    monkeypatch.chdir(nested)
    assert analysis_db.engine().url.query["http_path"] == "/sql/1.0/warehouses/here"


class FakeCursor:
    def __init__(self, ran: list[str]) -> None:
        self.ran = ran
        self.description: list[tuple] | None = None

    def execute(self, query: str) -> None:
        self.ran.append(query)
        if query.startswith("select"):
            self.description = [("country",), ("n",)]

    def fetchall(self) -> list[tuple]:
        return [("SE", 3), ("NO", 1)]


class FakeEngine:
    def __init__(self, start: Path, catalog: str | None, schema: str | None) -> None:
        self.start, self.catalog, self.schema = start, catalog, schema
        self.ran: list[str] = []
        self.closed = 0

    def raw_connection(self) -> object:
        engine = self

        class Connection:
            def cursor(self) -> FakeCursor:
                return FakeCursor(engine.ran)

            def close(self) -> None:
                engine.closed += 1

        return Connection()


def test_sql_returns_a_frame_and_keeps_one_engine_per_marker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[FakeEngine] = []

    def fake_engine(start: Path, *, catalog: str | None = None, schema: str | None = None) -> FakeEngine:
        made.append(FakeEngine(start, catalog, schema))
        return made[-1]

    monkeypatch.setattr(analysis_db, "engine", fake_engine)
    monkeypatch.setattr(analysis_db, "_engines", {})
    (tmp_path / "analysis.yaml").write_text("")
    (tmp_path / "lib").mkdir()

    frame = analysis_db.sql("select country, count(*) n from t where x::int > 0 and y like '%a'", start=tmp_path)
    assert list(frame.columns) == ["country", "n"]
    assert frame.values.tolist() == [["SE", 3], ["NO", 1]]
    # Sent as written: no bind parameters, no escaping.
    assert made[0].ran == ["select country, count(*) n from t where x::int > 0 and y like '%a'"]
    assert analysis_db.sql("set x = 1", start=tmp_path / "lib") is None
    assert len(made) == 1 and made[0].closed == 2
    analysis_db.sql("select 1", start=tmp_path, catalog="main")
    assert len(made) == 2 and made[1].catalog == "main"

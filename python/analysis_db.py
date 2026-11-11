"""Queries on the analysis's Databricks SQL warehouse, for notebook cells.

``sql("select ...")`` returns a pandas DataFrame; a ```` ```sql ```` cell in notebook.md runs through it,
in Claude's ``python -m analysis_notebook run`` and in the user's Molten kernel alike. ``engine()`` is the
SQLAlchemy engine under it. The profile and warehouse come from the nearest ``analysis.yaml`` file, with the
analysis defaults. There is no token to paste: the Databricks SDK asks the CLI
(``databricks auth token``) for the profile's OAuth token and refreshes it before it expires.

It lives in the Assay repo (``python/``); the app installs it into Assay's venv (``$ASSAY_VENV``).
"""

from __future__ import annotations

import importlib
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

DEFAULT_PROFILE = "Cint mkt"
DEFAULT_WAREHOUSE = "455a178462311474"
MARKER = "analysis.yaml"


def heavy(module: str, name: str) -> Any:
    """``name`` from ``module``, imported on first use.

    SQLAlchemy, the Databricks SDK and pandas take seconds to load, and ``python -m analysis_trust list`` imports this
    module without ever reaching a warehouse: so they are not imported at the top.
    """
    return getattr(importlib.import_module(module), name)


def find_marker(start: Path) -> Path | None:
    """The ``analysis.yaml`` file in ``start`` or the nearest folder above it, if any."""
    for folder in [start, *start.parents]:
        marker = folder / MARKER
        if marker.is_file():
            return marker
    return None


def read_target(text: str) -> dict[str, str]:
    """``profile`` and ``warehouse`` from a ``analysis.yaml`` file's ``key: value`` lines, defaults filled in.

    Read as the server reads them (``readTarget`` in ``src/core/engines.ts``): the first top-level line naming each
    key, any case, quotes and a trailing ``# comment`` dropped.
    """

    def value(key: str) -> str | None:
        found = re.search(rf"^{key}[ \t]*:[ \t]+(.+?)[ \t]*$", text, re.IGNORECASE | re.MULTILINE)
        if not found:
            return None
        raw = found.group(1)
        double = re.match(r'"((?:[^"\\]|\\.)*)"', raw)
        if double:
            # JSON string rules, as the server's scalar() reads them: "\n" is a newline.
            try:
                return str(json.loads(double.group(0)))
            except ValueError:
                return double.group(1)
        single = re.match(r"'((?:[^']|'')*)'", raw)
        if single:
            return single.group(1).replace("''", "'")
        return re.sub(r"(^|\s)#.*$", "", raw).strip() or None

    return {
        "profile": value("profile") or DEFAULT_PROFILE,
        "warehouse": value("warehouse") or DEFAULT_WAREHOUSE,
    }


def engine_url(host: str, warehouse: str, catalog: str | None = None, schema: str | None = None) -> str:
    """The ``databricks://`` URL of a warehouse, with no credentials in it."""
    query = {"http_path": f"/sql/1.0/warehouses/{warehouse}"}
    if catalog:
        query["catalog"] = catalog
    if schema:
        query["schema"] = schema
    bare_host = re.sub(r"^https?://", "", host).rstrip("/")
    return f"databricks://{bare_host}?{urlencode(query, safe='/')}"


def engine(start: str | Path | None = None, *, catalog: str | None = None, schema: str | None = None) -> Any:
    """A SQLAlchemy engine on the warehouse the nearest ``analysis.yaml`` names.

    ``start`` is where to look for ``analysis.yaml`` from: the working directory by default. ``catalog`` and
    ``schema`` set the defaults unqualified table names resolve against.

    The engine logs in through the CLI's OAuth for the profile (``auth_type="databricks-cli"``, so the SDK
    never tries to open a browser), turns off CloudFetch (its result downloads come from storage hosts the
    sandbox proxy does not allow) and telemetry, and checks a pooled connection before use, since the
    warehouse drops idle sessions.
    """
    marker = find_marker(Path(start) if start is not None else Path.cwd())
    target = read_target(marker.read_text() if marker else "")
    cfg = heavy("databricks.sdk.core", "Config")(profile=target["profile"], auth_type="databricks-cli")
    return heavy("sqlalchemy", "create_engine")(
        engine_url(cfg.host, target["warehouse"], catalog, schema),
        connect_args={
            "credentials_provider": lambda: cfg.authenticate,
            "use_cloud_fetch": False,
            "enable_telemetry": False,
        },
        pool_pre_ping=True,
    )


_engines: dict[tuple[str, str | None, str | None], Any] = {}


def sql(query: str, start: str | Path | None = None, *, catalog: str | None = None, schema: str | None = None) -> Any:
    """Runs one statement on the analysis's warehouse; its rows as a pandas DataFrame (None without rows).

    The statement goes to the connector as written, so ``:`` and ``%`` need no escaping. The engine is
    kept per ``analysis.yaml`` file, catalog and schema.
    """
    origin = Path(start) if start is not None else Path.cwd()
    marker = find_marker(origin)
    key = (str(marker), catalog, schema)
    if key not in _engines:
        _engines[key] = engine(origin, catalog=catalog, schema=schema)
    connection = _engines[key].raw_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(query)
        if cursor.description is None:
            return None
        columns = [column[0] for column in cursor.description]
        return heavy("pandas", "DataFrame")([tuple(row) for row in cursor.fetchall()], columns=columns)
    finally:
        connection.close()

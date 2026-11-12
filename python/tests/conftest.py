"""Every test gets its own ASSAY_LEDGER, a file that does not exist yet: ``approve`` writes it."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def ledger_path(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path_factory.mktemp("ledger") / "ledger.json"
    monkeypatch.setenv("ASSAY_LEDGER", str(path))
    return path

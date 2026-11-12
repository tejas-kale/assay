"""Writes the trust ledger the app would: ``approve(root)`` approves the files under ``trusted/`` and ``dictionaries/``
as they are now, in the file ``ASSAY_LEDGER`` names (conftest.py gives each test its own)."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


def approve(root: Path, *relative: str) -> None:
    """Approves the given root-relative files, or every file in ``trusted/`` and ``dictionaries/`` when none is given.
    Replaces what the ledger held."""
    if not relative:
        relative = tuple(
            str(path.relative_to(root))
            for folder in ("trusted", "dictionaries")
            for path in sorted((root / folder).glob("*"))
            if path.is_file()
        )
    entries = {
        Path(each).name: {
            "kind": "dictionary" if each.startswith("dictionaries/") else "calculation",
            "files": {each: hashlib.sha256((root / each).read_bytes()).hexdigest()},
            "approvedAt": "2026-11-12T00:00:00Z",
            "commit": "",
        }
        for each in relative
    }
    write_ledger({"version": 1, "entries": entries, "history": []})


def write_ledger(data: object) -> None:
    Path(os.environ["ASSAY_LEDGER"]).write_text(json.dumps(data))

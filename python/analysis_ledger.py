"""The trust ledger, read: which files of ``trusted/`` and ``dictionaries/`` the user approved in the app, by hash.

The app writes the ledger (``src/main/trustLedger.ts``, specs/trust-ledger.md) and passes its path as ``ASSAY_LEDGER``.
This module only reads it, under the same rules as ``src/core/trustLedger.ts``: a strict parse, and anything wrong
(no variable, no file, a link, bad JSON, a wrong shape) trusts nothing and says why in one line. A file is trusted
when some entry lists its root-relative path with the sha256 of its bytes as they are now.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any, NamedTuple

ENV = "ASSAY_LEDGER"
SHA256 = re.compile(r"[0-9a-f]{64}")
FORBIDDEN = frozenset({"__proto__", "constructor", "prototype"})
KINDS = ("calculation", "dictionary")


class Ledger(NamedTuple):
    """``files`` maps a root-relative path to the hashes approved for it; ``problem`` says why it is empty, if it is."""

    files: dict[str, frozenset[str]]
    problem: str | None


NOTHING = "nothing is trusted until the user approves it in Assay"


def _distrust(why: str) -> Ledger:
    return Ledger({}, f"{why}: {NOTHING}.")


def _entry_files(entry: Any) -> dict[str, str] | None:
    """The ``files`` of a well-formed entry, or None."""
    if not isinstance(entry, dict) or entry.get("kind") not in KINDS:
        return None
    if not isinstance(entry.get("approvedAt"), str) or not isinstance(entry.get("commit"), str):
        return None
    files = entry.get("files")
    if not isinstance(files, dict):
        return None
    for path, digest in files.items():
        if path in FORBIDDEN or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            return None
    return files


def _shaped(data: Any) -> dict[str, frozenset[str]] | None:
    """Every approved path of a version 1 ledger, or None when any part of it is the wrong shape."""
    if not isinstance(data, dict) or data.get("version") != 1:
        return None
    entries, history = data.get("entries"), data.get("history")
    if not isinstance(entries, dict) or not isinstance(history, list):
        return None
    approved: dict[str, set[str]] = {}
    for name, entry in entries.items():
        files = _entry_files(entry)
        if name in FORBIDDEN or files is None:
            return None
        for path, digest in files.items():
            approved.setdefault(path, set()).add(digest)
    if any(_entry_files(old) is None or not isinstance(old.get("name"), str) for old in history):
        return None
    return {path: frozenset(digests) for path, digests in approved.items()}


def _read(path: str) -> str | Ledger:
    """The ledger's text, or the empty ledger saying why it cannot be read."""
    if Path(path).is_symlink():
        return _distrust("The trust ledger is a link")
    try:
        return Path(path).read_text()
    except FileNotFoundError:
        return _distrust("The app has not approved anything yet")
    except (OSError, UnicodeDecodeError) as error:
        return _distrust(f"The trust ledger cannot be read ({type(error).__name__})")


def load(env: Mapping[str, str] | None = None) -> Ledger:
    """The ledger ``ASSAY_LEDGER`` names. Never raises."""
    path = (os.environ if env is None else env).get(ENV)
    if not path:
        return _distrust(f"{ENV} is not set")
    text = _read(path)
    if isinstance(text, Ledger):
        return text
    try:
        approved = _shaped(json.loads(text))
    except ValueError:
        return _distrust("The trust ledger is not valid JSON")
    if approved is None:
        return _distrust("The trust ledger is not in the expected shape (version 1)")
    return Ledger(approved, None)


def sha256_of(path: Path) -> str | None:
    """The sha256 hex of the file's bytes now, or None when it cannot be read."""
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


class Read(NamedTuple):
    """A file's bytes, read once, and whether the ledger approves exactly those bytes. ``data`` is None when the file
    cannot be read. Whatever uses the file afterwards must use ``data``, never open the path again (PI-2)."""

    data: bytes | None
    trusted: bool


def read_checked(ledger: Ledger, root: Path, relative: str) -> Read:
    """``root/relative``, read once, with the verdict on those bytes."""
    try:
        data = (root / relative).read_bytes()
    except OSError:
        return Read(None, False)
    return Read(data, hashlib.sha256(data).hexdigest() in ledger.files.get(relative, frozenset()))


def is_trusted(ledger: Ledger, root: Path, relative: str) -> bool:
    """Whether ``root/relative`` is listed in the ledger with the hash of its current bytes."""
    return read_checked(ledger, root, relative).trusted

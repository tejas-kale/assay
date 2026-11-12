"""The trusted library under a root: every calculation in ``trusted/`` and every definition in ``dictionaries/``.

Each comes with the commit that last changed its file (shown, never trusted) and whether it is trusted: only a file
the user approved in the app, with the bytes it has now, is (``analysis_ledger``, specs/trust-ledger.md). ``dirty`` is
true for every other file.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, NamedTuple

import analysis_ledger
from analysis_calc import NAME, Source, TrustError, describe
from analysis_dictionary import DICTIONARIES, definitions_of, describe_definition, dictionary_files, parse_entry

TRUSTED = "trusted"
GIT_SECONDS = 20
COMMIT_CHARS = 12
NOT_APPROVED = "Not approved in the app yet: its code is not run until you approve it."


def git(folder: Path, *args: str) -> str:
    """git's output in ``folder``, or '' when git fails (no repository, no git)."""
    try:
        ran = subprocess.run(
            ["git", "-C", str(folder), *args], capture_output=True, text=True, timeout=GIT_SECONDS, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return ran.stdout.strip() if ran.returncode == 0 else ""


class Listing(NamedTuple):
    """What ``scan`` found. ``entries`` maps each readable dictionary table to its parsed entry, from the bytes the
    verdict was reached on: nothing that uses the listing reads those files again (PI-2)."""

    calculations: list[dict[str, Any]]
    problems: list[str]
    entries: dict[str, dict[str, Any]]


def file_state(root: Path, relative: str, trusted: bool) -> dict[str, Any]:
    """The commit that last changed ``root/relative`` (display only), and ``dirty``: true unless the ledger approved
    the bytes that were read."""
    commit = git(root, "log", "-1", "--format=%H", "--", relative)
    return {"commit": commit[:COMMIT_CHARS], "dirty": not trusted}


def list_calculations(notes_src: Path) -> dict[str, Any]:
    """Every calculation and definition, with its commit and whether it is approved; files that are not usable, and
    why nothing is approved when the ledger cannot be read, are listed under ``problems``."""
    found = scan(notes_src)
    return {"calculations": found.calculations, "problems": found.problems}


def scan(notes_src: Path) -> Listing:
    """``list_calculations``, with the dictionary entries it read.

    Every file is read and judged against the ledger first, before any calculation's code runs. Only an approved
    Python calculation is then run (from the bytes judged, ``analysis_calc.load_module``) to describe it, so the code
    that runs cannot change a verdict already reached. An unapproved calculation is never run: its listing says so.
    """
    ledger = analysis_ledger.load()
    folder = notes_src / TRUSTED
    calculation_reads = [_read_calculation(notes_src, ledger, name) for name in _calculation_names(folder)]
    dictionary_reads = [
        (table, path, analysis_ledger.read_checked(ledger, notes_src, f"{DICTIONARIES}/{path.name}"))
        for table, path in sorted(dictionary_files(notes_src).items())
    ]
    calculations: list[dict[str, Any]] = []
    problems: list[str] = []
    entries: dict[str, dict[str, Any]] = {}
    for name, file, read in calculation_reads:
        try:
            calculations.append(_calculation_listed(notes_src, name, file, read))
        except Exception as error:
            problems.append(f"{name}: {error}")
    for table, path, read in dictionary_reads:
        try:
            entry = parse_entry(_decoded(read), path.name)
            items = definitions_of(entry)
        except Exception as error:
            problems.append(f"{path.name}: {error}")
            continue
        entries[table] = entry
        state = file_state(notes_src, f"{DICTIONARIES}/{path.name}", read.trusted) if items else {}
        calculations += _definitions_listed(table, Source(table, path.name, _bytes(read)), items, state)
    if ledger.problem and calculations:
        problems.append(ledger.problem)
    return Listing(calculations, problems, entries)


def _bytes(read: analysis_ledger.Read) -> bytes:
    if read.data is None:
        raise TrustError("cannot be read")
    return read.data


def _decoded(read: analysis_ledger.Read) -> str:
    return _bytes(read).decode()


def _read_calculation(
    notes_src: Path, ledger: analysis_ledger.Ledger, name: str
) -> tuple[str, str | None, analysis_ledger.Read]:
    """Calculation ``name``'s file name (None unless it has exactly one) and its bytes with the ledger's verdict."""
    folder = notes_src / TRUSTED
    files = [f"{name}{suffix}" for suffix in (".sql", ".py") if (folder / f"{name}{suffix}").is_file()]
    if len(files) != 1:
        return name, None, analysis_ledger.Read(None, False)
    return name, files[0], analysis_ledger.read_checked(ledger, notes_src, f"{TRUSTED}/{files[0]}")


def _calculation_listed(notes_src: Path, name: str, file: str | None, read: analysis_ledger.Read) -> dict[str, Any]:
    folder = notes_src / TRUSTED
    if file is None:
        raise TrustError(f"need exactly one of {name}.sql and {name}.py in {folder}")
    source = Source(name, file, _bytes(read))
    if file.endswith(".py") and not read.trusted:
        found = {"name": name, "kind": "python", "file": file, "description": NOT_APPROVED, "parameters": []}
    else:
        found = describe(folder, name, source)
    path = f"{TRUSTED}/{found['file']}"
    return {**found, "path": path, **file_state(notes_src, path, read.trusted)}


def require_trusted(notes_src: Path, name: str) -> Source:
    """The file behind calculation or definition ``name``, read once, when the app approved exactly those bytes; a
    TrustError when it did not. Run or render the returned bytes, never the path again (PI-2)."""
    table, colon, _ = name.partition(":")
    if colon:
        relative = f"{DICTIONARIES}/{table}.yaml"
    else:
        sql = f"{TRUSTED}/{name}.sql"
        relative = sql if (notes_src / sql).is_file() else f"{TRUSTED}/{name}.py"
    ledger = analysis_ledger.load()
    read = analysis_ledger.read_checked(ledger, notes_src, relative)
    if read.data is None or not read.trusted:
        why = ledger.problem or f"{relative} is not approved in the app, or changed after it was"
        raise TrustError(f"{name} is not trusted: {why}")
    return Source(name, Path(relative).name, read.data)


def _calculation_names(folder: Path) -> list[str]:
    if not folder.is_dir():
        return []
    stems = {path.stem for path in folder.glob("*") if path.suffix in (".sql", ".py")}
    return sorted(stem for stem in stems if NAME.match(stem) and not stem.startswith("test_"))


def _definitions_listed(
    table: str, source: Source, items: list[dict[str, Any]], state: dict[str, Any]
) -> list[dict[str, Any]]:
    listed = []
    for item in items:
        full = f"{table}:{item['name']}"
        found = describe_definition(Path(), full, Source(full, source.file, source.data))
        del found["entry"]
        listed.append({**found, "path": f"{DICTIONARIES}/{source.file}", **state})
    return listed

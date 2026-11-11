"""The trusted library under a root: every calculation in ``trusted/`` and every definition in ``dictionaries/``.

Each comes with the commit that last changed its file and whether the file differs from it: only what is committed
unchanged is trusted.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from analysis_calc import NAME, describe
from analysis_dictionary import DICTIONARIES, definitions_of, describe_definition, dictionary_files, read_entry

TRUSTED = "trusted"
GIT_SECONDS = 20
COMMIT_CHARS = 12


def git(folder: Path, *args: str) -> str:
    """git's output in ``folder``, or '' when git fails (no repository, no git)."""
    try:
        ran = subprocess.run(
            ["git", "-C", str(folder), *args], capture_output=True, text=True, timeout=GIT_SECONDS, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return ran.stdout.strip() if ran.returncode == 0 else ""


def file_state(folder: Path, file: str) -> dict[str, Any]:
    """The commit that last changed ``file`` and whether it differs from that commit (or was never committed)."""
    commit = git(folder, "log", "-1", "--format=%H", "--", file)
    changed = bool(git(folder, "status", "--porcelain", "--", file))
    return {"commit": commit[:COMMIT_CHARS], "dirty": changed or not commit}


def list_calculations(notes_src: Path) -> dict[str, Any]:
    """Every trusted calculation, with its commit; files that are not usable are listed under ``problems``."""
    calculations: list[dict[str, Any]] = []
    problems: list[str] = []
    folder = notes_src / TRUSTED
    for name in _calculation_names(folder):
        try:
            found = describe(folder, name)
        except Exception as error:
            problems.append(f"{name}: {error}")
            continue
        calculations.append({**found, "path": f"{TRUSTED}/{found['file']}", **file_state(folder, found["file"])})
    for table, path in sorted(dictionary_files(notes_src).items()):
        try:
            items = definitions_of(read_entry(path))
        except Exception as error:
            problems.append(f"{path.name}: {error}")
            continue
        calculations += _definitions_listed(table, path, items)
    return {"calculations": calculations, "problems": problems}


def _calculation_names(folder: Path) -> list[str]:
    if not folder.is_dir():
        return []
    stems = {path.stem for path in folder.glob("*") if path.suffix in (".sql", ".py")}
    return sorted(stem for stem in stems if NAME.match(stem) and not stem.startswith("test_"))


def _definitions_listed(table: str, path: Path, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    state = file_state(path.parent, path.name) if items else {}
    listed = []
    for item in items:
        found = describe_definition(path.parent, f"{table}:{item['name']}")
        del found["entry"]
        listed.append({**found, "path": f"{DICTIONARIES}/{path.name}", **state})
    return listed

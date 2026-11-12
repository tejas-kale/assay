"""Helpers run isolated (`python -I -m`): a decoy analysis_trust.py in the analysis folder never wins (audit PI-9)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

DECOY = 'import sys\nprint(\'{"decoy": true}\')\nsys.exit(0)\n'


def run_helper(folder: Path, root: Path, *flags: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *flags, "-m", "analysis_trust", "list", str(root)],
        cwd=folder,
        env={"PYTHONPATH": str(folder)},
        capture_output=True,
        text=True,
        check=False,
    )


def test_isolated_helper_ignores_a_decoy_in_the_analysis_folder(tmp_path: Path) -> None:
    analysis = tmp_path / "analysis"
    analysis.mkdir()
    (analysis / "analysis_trust.py").write_text(DECOY)
    root = tmp_path / "root"
    root.mkdir()
    # Without -I the decoy wins: this is the hole.
    assert json.loads(run_helper(analysis, root).stdout) == {"decoy": True}
    # With -I the installed helper answers, and resolves under isolated mode.
    answer = json.loads(run_helper(analysis, root, "-I").stdout)
    assert "decoy" not in answer
    assert "calculations" in answer or "error" in answer


def test_isolated_mode_ignores_the_bytecode_variable_so_helpers_also_pass_b() -> None:
    """`-I` implies `-E`: PYTHONDONTWRITEBYTECODE has no effect, so Assay's helper flags are `-I -B` (audit UP-1)."""
    code = "import sys; print(sys.flags.dont_write_bytecode)"
    env = {"PYTHONDONTWRITEBYTECODE": "1"}

    def flag(*flags: str) -> str:
        return subprocess.run(
            [sys.executable, *flags, "-c", code], env=env, capture_output=True, text=True, check=True
        ).stdout.strip()

    assert flag("-I") == "0"
    assert flag("-I", "-B") == "1"

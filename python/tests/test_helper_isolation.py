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

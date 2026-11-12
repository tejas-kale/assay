"""How Assay loads an approved calculation's Python (PI-2): from the bytes the ledger approved, never from a cache."""

from __future__ import annotations

import importlib
import importlib.util
import sys
from importlib import _bootstrap_external  # type: ignore[attr-defined]
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from ledger_helper import approve

import analysis_calc as calc
import analysis_library as library

GOOD = "def counts(engine):\n    '''Counts.'''\n    return 1\n"
EVIL = "import pathlib\npathlib.Path(__file__).with_name('ran').write_text('x')\n" + GOOD


def plant_cache(path: Path, evil: str) -> Path:
    """A ``.pyc`` of ``evil`` whose header matches ``path``'s modification time and size, where Python looks for one."""
    stat = path.stat()
    code = compile(evil, str(path), "exec")
    cached = Path(importlib.util.cache_from_source(str(path)))
    cached.parent.mkdir(exist_ok=True)
    cached.write_bytes(_bootstrap_external._code_to_timestamp_pyc(code, int(stat.st_mtime), stat.st_size))
    return cached


def test_a_planted_pyc_next_to_an_approved_py_does_not_run(tmp_path: Path) -> None:
    path = tmp_path / "counts.py"
    path.write_text(GOOD)
    cached = plant_cache(path, EVIL)
    # The header records the source's size, so make the source exactly as long as the evil code the cache holds.
    path.write_text(GOOD + "#" * (len(EVIL) - len(GOOD)))
    stat = path.stat()
    code = compile(EVIL, str(path), "exec")
    cached.write_bytes(_bootstrap_external._code_to_timestamp_pyc(code, int(stat.st_mtime), stat.st_size))
    module = calc.load_module(path)
    assert module.counts(None) == 1
    assert not (tmp_path / "ran").exists()


def test_the_module_is_built_from_the_given_bytes_not_the_file(tmp_path: Path) -> None:
    path = tmp_path / "counts.py"
    path.write_text("def counts(engine):\n    '''Other.'''\n    return 2\n")
    module = calc.load_module(path, GOOD.encode())
    assert module.counts(None) == 1
    assert module.__name__ == "trusted_counts"
    assert module.__file__ == str(path)


# ---------------------------------------------------------------------------
# A trusted calculation's local imports (PI-2): only ledger-approved siblings load, from the approved bytes.

HELPER_VALUE = 7
PACKAGE_VALUE = 3
USES_HELPER = "import helper\n\n\ndef uses(engine):\n    '''Uses a helper.'''\n    return helper.VALUE\n"
LAZY_HELPER = "def uses(engine):\n    '''Imports late.'''\n    import helper\n\n    return helper.VALUE\n"


def trusted_root(tmp_path: Path, calculation: str = USES_HELPER, helper: str | None = "VALUE = 7\n") -> Path:
    (tmp_path / "trusted").mkdir()
    (tmp_path / "trusted" / "uses.py").write_text(calculation)
    if helper is not None:
        (tmp_path / "trusted" / "helper.py").write_text(helper)
    return tmp_path


def test_an_approved_calculation_imports_an_approved_sibling(tmp_path: Path) -> None:
    root = trusted_root(tmp_path)
    approve(root)
    function, _, _ = calc.python_function(root / "trusted" / "uses.py")
    assert function(None) == HELPER_VALUE
    assert "helper" not in sys.modules


def test_a_late_import_inside_the_function_is_checked_too(tmp_path: Path) -> None:
    root = trusted_root(tmp_path, LAZY_HELPER)
    approve(root, "trusted/uses.py")
    function, _, _ = calc.python_function(root / "trusted" / "uses.py")
    with calc.trusted_imports(root / "trusted"), pytest.raises(ImportError, match="not approved in the app"):
        function(None)
    approve(root)
    with calc.trusted_imports(root / "trusted"):
        assert function(None) == HELPER_VALUE


def test_an_unapproved_sibling_does_not_run(tmp_path: Path) -> None:
    root = trusted_root(tmp_path, helper="import pathlib\npathlib.Path(__file__).with_name('ran').write_text('x')\n")
    approve(root, "trusted/uses.py")
    with pytest.raises(ImportError, match="not approved in the app"):
        calc.python_function(root / "trusted" / "uses.py")
    assert not (root / "trusted" / "ran").exists()


def test_a_sibling_changed_after_approval_does_not_run(tmp_path: Path) -> None:
    root = trusted_root(tmp_path)
    approve(root)
    (root / "trusted" / "helper.py").write_text("VALUE = 8\n")
    with pytest.raises(ImportError, match="not approved in the app"):
        calc.python_function(root / "trusted" / "uses.py")


def test_a_planted_pyc_for_an_approved_sibling_is_ignored(tmp_path: Path) -> None:
    root = trusted_root(tmp_path)
    approve(root)
    helper = root / "trusted" / "helper.py"
    helper.write_text("VALUE = 7\n" + "#" * 20)
    approve(root)
    cached = plant_cache(helper, "VALUE = 99\n" + "#" * 19)
    assert cached.exists()
    function, _, _ = calc.python_function(root / "trusted" / "uses.py")
    assert function(None) == HELPER_VALUE


def test_a_package_of_approved_files_imports(tmp_path: Path) -> None:
    uses = "from pkg import sub\n\n\ndef uses(engine):\n    '''Uses.'''\n    return sub.VALUE\n"
    root = trusted_root(tmp_path, uses, None)
    (root / "trusted" / "pkg").mkdir()
    (root / "trusted" / "pkg" / "__init__.py").write_text("")
    (root / "trusted" / "pkg" / "sub.py").write_text("VALUE = 3\n")
    approve(root, "trusted/uses.py", "trusted/pkg/__init__.py", "trusted/pkg/sub.py")
    function, _, _ = calc.python_function(root / "trusted" / "uses.py")
    assert function(None) == PACKAGE_VALUE
    (root / "trusted" / "pkg" / "sub.py").write_text("VALUE = 4\n")
    with pytest.raises(ImportError, match="not approved in the app"):
        calc.python_function(root / "trusted" / "uses.py")


def test_a_directory_without_an_approved_init_is_refused(tmp_path: Path) -> None:
    root = trusted_root(tmp_path, "import pkg\n\n\ndef uses(engine):\n    '''Uses.'''\n", None)
    (root / "trusted" / "pkg").mkdir()
    approve(root, "trusted/uses.py")
    with pytest.raises(ImportError, match="not approved in the app"):
        calc.python_function(root / "trusted" / "uses.py")


def test_the_standard_library_is_unaffected_and_the_finder_is_removed(tmp_path: Path) -> None:
    root = trusted_root(tmp_path, "import json\n" + USES_HELPER, None)
    (root / "trusted" / "helper.py").write_text("VALUE = 7\n")
    approve(root)
    before = list(sys.meta_path)
    calc.python_function(root / "trusted" / "uses.py")
    assert sys.meta_path == before


def test_listing_an_approved_calculation_with_an_unapproved_import_reports_a_problem(tmp_path: Path) -> None:
    root = trusted_root(tmp_path, helper="import pathlib\npathlib.Path(__file__).with_name('ran').write_text('x')\n")
    approve(root, "trusted/uses.py")
    listed = library.list_calculations(root)
    assert [each["name"] for each in listed["calculations"]] == ["helper"]
    assert any("uses" in problem and "not approved in the app" in problem for problem in listed["problems"])
    assert not (root / "trusted" / "ran").exists()


def test_a_standard_library_module_is_not_shadowed_by_an_unapproved_file_of_its_name(tmp_path: Path) -> None:
    uses = "import colorsys\n\n\ndef uses(engine):\n    '''Uses the stdlib.'''\n    return colorsys.__file__\n"
    root = trusted_root(tmp_path, uses, None)
    (root / "trusted" / "colorsys.py").write_text("raise SystemExit('shadowed')\n")
    approve(root, "trusted/uses.py")
    sys.modules.pop("colorsys", None)
    function, _, _ = calc.python_function(root / "trusted" / "uses.py")
    assert not str(function(None)).startswith(str(root))


def test_a_module_found_inside_the_root_through_sys_path_is_checked_against_the_ledger(tmp_path: Path) -> None:
    root = trusted_root(tmp_path, GOOD, "import pathlib\npathlib.Path(__file__).with_name('ran').write_text('x')\n")
    approve(root, "trusted/uses.py")
    sys.path.insert(0, str(root))
    try:
        with calc.trusted_imports(root / "trusted"), pytest.raises(ImportError, match="not approved in the app"):
            importlib.import_module("trusted.helper")
    finally:
        sys.path.remove(str(root))
        for name in [name for name in sys.modules if name == "trusted" or name.startswith("trusted.")]:
            del sys.modules[name]
    assert not (root / "trusted" / "ran").exists()


def test_a_sourceless_cache_inside_trusted_is_refused(tmp_path: Path) -> None:
    root = trusted_root(tmp_path, GOOD, None)
    approve(root)
    compiled = compile("import pathlib\npathlib.Path(__file__).with_name('ran').write_text('x')\n", "planted", "exec")
    (root / "trusted" / "planted.pyc").write_bytes(_bootstrap_external._code_to_timestamp_pyc(compiled, 0, 0))
    sys.path.insert(0, str(root / "trusted"))
    try:
        with calc.trusted_imports(root / "trusted"), pytest.raises(ImportError, match="not approved in the app"):
            importlib.import_module("planted")
    finally:
        sys.path.remove(str(root / "trusted"))
        sys.modules.pop("planted", None)
    assert not (root / "trusted" / "ran").exists()

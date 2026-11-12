"""What the trust ledger decides (PI-2, specs/trust-ledger.md): a file is trusted when the app approved its bytes."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from ledger_helper import approve, write_ledger

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analysis_calc as calc
import analysis_include as include
import analysis_ledger as ledger_
import analysis_library as library
import analysis_runner as runner
import analysis_trust as trust

CALC = "/*---\ndescription: Counts.\n---*/\nSELECT 1\n"
ENTRY = (
    "description: surveys\ndefinitions:\n  - name: done\n    kind: filter\n    description: Done.\n"
    "    sql: state = 'C'\n"
)
SHORT_COMMIT = 12


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "trusted").mkdir()
    (tmp_path / "dictionaries").mkdir()
    (tmp_path / "trusted" / "counts.sql").write_text(CALC)
    (tmp_path / "dictionaries" / "main.panel.surveys.yaml").write_text(ENTRY)
    for args in (["init", "-q"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]):
        subprocess.run(["git", "-C", str(tmp_path), *args], check=True)
    return tmp_path


def dirty(root: Path) -> dict[str, bool]:
    return {each["name"]: each["dirty"] for each in library.list_calculations(root)["calculations"]}


def test_a_committed_file_the_app_never_approved_is_not_trusted(root: Path) -> None:
    listed = library.list_calculations(root)
    assert [each["dirty"] for each in listed["calculations"]] == [True, True]
    assert all(len(each["commit"]) == SHORT_COMMIT for each in listed["calculations"])
    assert listed["problems"] == [
        "The app has not approved anything yet: nothing is trusted until the user approves it in Assay."
    ]


def test_an_approved_file_is_trusted_until_its_bytes_change(root: Path) -> None:
    approve(root)
    assert dirty(root) == {"counts": False, "main.panel.surveys:done": False}
    (root / "trusted" / "counts.sql").write_text(CALC + "-- edited\n")
    (root / "dictionaries" / "main.panel.surveys.yaml").write_text(ENTRY + "# edited\n")
    assert dirty(root) == {"counts": True, "main.panel.surveys:done": True}


def test_approving_one_file_trusts_only_that_file(root: Path) -> None:
    approve(root, "trusted/counts.sql")
    assert dirty(root) == {"counts": False, "main.panel.surveys:done": True}


def test_no_ledger_variable_trusts_nothing(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    approve(root)
    monkeypatch.delenv("ASSAY_LEDGER")
    listed = library.list_calculations(root)
    assert [each["dirty"] for each in listed["calculations"]] == [True, True]
    assert listed["problems"] == ["ASSAY_LEDGER is not set: nothing is trusted until the user approves it in Assay."]


def test_an_empty_root_lists_nothing_and_no_problem(tmp_path: Path) -> None:
    assert library.list_calculations(tmp_path) == {"calculations": [], "problems": []}


BAD = [
    ("{", "is not valid JSON"),
    ("[]", "not in the expected shape"),
    ('{"version": 2, "entries": {}, "history": []}', "not in the expected shape"),
    ('{"version": 1, "entries": {}}', "not in the expected shape"),
    ('{"version": 1, "entries": {"a": {"kind": "other"}}, "history": []}', "not in the expected shape"),
    ('{"version": 1, "entries": {}, "history": [{"kind": "calculation"}]}', "not in the expected shape"),
]


@pytest.mark.parametrize(("text", "said"), BAD)
def test_a_damaged_ledger_trusts_nothing_and_says_so(root: Path, ledger_path: Path, text: str, said: str) -> None:
    approve(root)
    ledger_path.write_text(text)
    listed = library.list_calculations(root)
    assert [each["dirty"] for each in listed["calculations"]] == [True, True]
    assert said in listed["problems"][-1]


def test_a_malformed_hash_or_entry_field_is_refused() -> None:
    def entry(**changes: Any) -> dict[str, Any]:
        good = {"kind": "calculation", "files": {"trusted/a.sql": "a" * 64}, "approvedAt": "t", "commit": ""}
        return {**good, **changes}

    def ledger(entries: dict[str, Any]) -> dict[str, Any]:
        return {"version": 1, "entries": entries, "history": []}

    assert ledger_.load({"ASSAY_LEDGER": "/nonexistent"}).problem is not None
    for bad in (
        entry(files={"trusted/a.sql": "nothex"}),
        entry(files={"__proto__": "a" * 64}),
        entry(files=[]),
        entry(approvedAt=1),
        entry(commit=None),
    ):
        assert ledger_._shaped(ledger({"a": bad})) is None
    assert ledger_._shaped(ledger({"__proto__": entry()})) is None
    assert ledger_._shaped(ledger({"a": entry()})) == {"trusted/a.sql": frozenset({"a" * 64})}


def test_a_ledger_that_is_a_link_or_unreadable_trusts_nothing(root: Path, ledger_path: Path, tmp_path: Path) -> None:
    approve(root)
    link = tmp_path / "link.json"
    link.symlink_to(ledger_path)
    assert "is a link" in ledger_.load({"ASSAY_LEDGER": str(link)}).problem  # type: ignore[operator]
    ledger_path.write_bytes(b"\xff\xfe")
    assert "cannot be read" in ledger_.load().problem  # type: ignore[operator]
    folder = tmp_path / "folder.json"
    folder.mkdir()
    assert "cannot be read" in ledger_.load({"ASSAY_LEDGER": str(folder)}).problem  # type: ignore[operator]


def test_a_listed_file_that_is_gone_is_not_trusted(root: Path) -> None:
    approve(root)
    (root / "trusted" / "counts.sql").unlink()
    assert not ledger_.is_trusted(ledger_.load(), root, "trusted/counts.sql")
    assert ledger_.sha256_of(root / "trusted" / "counts.sql") is None


def test_run_and_render_refuse_a_file_that_is_not_approved(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    for command, name, extra in (("run", "counts", [str(tmp_path)]), ("render", "main.panel.surveys:done", [])):
        assert trust.main([command, str(root), name, "{}", *extra]) == 1
        said = json.loads(capsys.readouterr().out)["error"]
        assert said.startswith(f"{name} is not trusted: The app has not approved"), said


def test_an_edit_after_approval_is_named_in_the_refusal(root: Path) -> None:
    approve(root)
    (root / "trusted" / "counts.py").write_text("def counts(engine):\n    '''x'''\n")
    (root / "trusted" / "counts.sql").unlink()
    with pytest.raises(calc.TrustError, match=r"trusted/counts\.py is not approved in the app, or changed"):
        library.require_trusted(root, "counts")
    library.require_trusted(root, "main.panel.surveys:done")
    (root / "dictionaries" / "main.panel.surveys.yaml").write_text(ENTRY + "# edited\n")
    with pytest.raises(calc.TrustError, match=r"main\.panel\.surveys:done is not trusted"):
        library.require_trusted(root, "main.panel.surveys:done")


def test_the_isolated_helper_still_reads_ledger_from_the_environment(root: Path, ledger_path: Path) -> None:
    approve(root)
    env = {"ASSAY_LEDGER": str(ledger_path), "PYTHONPATH": ""}
    ran = subprocess.run(
        [sys.executable, "-I", "-B", "-m", "analysis_trust", "list", str(root)],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    listed = json.loads(ran.stdout)
    assert [each["dirty"] for each in listed["calculations"]] == [False, False], ran.stderr
    write_ledger({"version": 1, "entries": {}, "history": []})
    again = subprocess.run(
        [sys.executable, "-I", "-B", "-m", "analysis_trust", "list", str(root)],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert [each["dirty"] for each in json.loads(again.stdout)["calculations"]] == [True, True]


def test_run_and_render_go_ahead_for_an_approved_file(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    approve(root)
    monkeypatch.setattr(
        runner, "run_checked", lambda _folder, source, _given, _analysis: {"columns": [], "rows": [source.name]}
    )
    assert trust.main(["run", str(root), "counts", "{}", str(tmp_path)]) == 0
    assert json.loads(capsys.readouterr().out) == {"columns": [], "rows": ["counts"]}
    assert trust.main(["render", str(root), "main.panel.surveys:done", "{}"]) == 0
    assert "sql" in json.loads(capsys.readouterr().out)


def swapped_after_verification(monkeypatch: pytest.MonkeyPatch, path: Path, other: str) -> None:
    """``trust`` verifies the file, then ``path`` is rewritten to ``other``: what a writer racing the run would do."""
    verify = trust.require_trusted

    def verified_then_swapped(*args: Any) -> Any:
        found = verify(*args)
        path.write_text(other)
        return found

    monkeypatch.setattr(trust, "require_trusted", verified_then_swapped)


def test_a_sql_calculation_swapped_after_verification_runs_the_approved_text(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    approve(root)
    ran: list[str] = []
    monkeypatch.setattr(runner, "run_table", lambda sql, _values, _analysis: ran.append(sql) or {"rows": []})
    swapped_after_verification(monkeypatch, root / "trusted" / "counts.sql", CALC.replace("SELECT 1", "SELECT 666"))
    assert trust.main(["run", str(root), "counts", "{}", str(tmp_path)]) == 0
    assert ran == ["SELECT 1"], capsys.readouterr().out


def test_a_python_calculation_swapped_after_verification_runs_the_approved_code(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    code = "def counts(engine):\n    '''Counts.'''\n    return pandas.DataFrame({{'v': ['{}']}})\n"
    (root / "trusted" / "counts.sql").unlink()
    (root / "trusted" / "counts.py").write_text("import pandas\n" + code.format("approved"))
    approve(root)
    monkeypatch.setattr(runner.analysis_db, "engine", lambda start=None: None)
    swapped_after_verification(monkeypatch, root / "trusted" / "counts.py", "import pandas\n" + code.format("evil"))
    assert trust.main(["run", str(root), "counts", "{}", str(tmp_path)]) == 0
    assert json.loads(capsys.readouterr().out)["rows"] == [["approved"]]


def test_a_definition_swapped_after_verification_renders_the_approved_entry(
    root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    approve(root)
    swapped_after_verification(
        monkeypatch, root / "dictionaries" / "main.panel.surveys.yaml", ENTRY.replace("state = 'C'", "1 = 1")
    )
    assert trust.main(["render", str(root), "main.panel.surveys:done", "{}"]) == 0
    assert "state = 'C'" in json.loads(capsys.readouterr().out)["sql"]


def test_a_file_is_read_once_and_the_bytes_hashed_are_the_bytes_returned(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    approve(root)
    assert ledger_.read_checked(ledger_.load(), root, "trusted/missing.sql") == ledger_.Read(None, False)
    reads = iter([CALC.encode(), b"SELECT 666"])
    monkeypatch.setattr(Path, "read_bytes", lambda self: next(reads))
    read = ledger_.read_checked(ledger_.load(), root, "trusted/counts.sql")
    assert read == ledger_.Read(CALC.encode(), True)


FORGER = (
    "import pathlib\nimport analysis_ledger\n"
    "pathlib.Path(__file__).with_name('forger-ran').write_text('x')\n"
    "analysis_ledger.is_trusted = lambda *a: True\n"
    "analysis_ledger.read_checked = lambda *a: analysis_ledger.Read(b'', True)\n"
    "def {name}(engine):\n    '''Forges.'''\n"
)


def keep_ledger_functions(monkeypatch: pytest.MonkeyPatch) -> None:
    """A module under test overwrites the ledger's functions; the monkeypatch puts them back afterwards."""
    for each in ("is_trusted", "read_checked"):
        monkeypatch.setattr(ledger_, each, getattr(ledger_, each))


def test_listing_never_runs_an_unapproved_calculation(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    keep_ledger_functions(monkeypatch)
    (root / "trusted" / "forger.py").write_text(FORGER.format(name="forger"))
    approve(root, "trusted/counts.sql")
    listed = {each["name"]: each for each in library.list_calculations(root)["calculations"]}
    assert not (root / "trusted" / "forger-ran").exists()
    assert listed["forger"]["dirty"] is True
    assert listed["forger"]["path"] == "trusted/forger.py"
    assert "Not approved" in listed["forger"]["description"]
    assert listed["counts"]["dirty"] is False


def test_an_approved_calculation_cannot_flip_the_verdict_on_others(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    keep_ledger_functions(monkeypatch)
    (root / "trusted" / "forger.py").write_text(FORGER.format(name="forger"))
    (root / "trusted" / "helper.py").write_text(FORGER.format(name="helper").replace("forger-ran", "helper-ran"))
    approve(root, "trusted/helper.py", "trusted/counts.sql")
    listed = {each["name"]: each["dirty"] for each in library.list_calculations(root)["calculations"]}
    assert (root / "trusted" / "helper-ran").exists()  # approved code does run, to be described
    assert listed == {"counts": False, "forger": True, "helper": False, "main.panel.surveys:done": True}


def test_an_unapproved_template_is_still_described_without_running_anything(root: Path) -> None:
    (root / "trusted" / "other.sql").write_text(CALC.replace("Counts.", "Other."))
    approve(root, "trusted/counts.sql")
    other = next(each for each in library.list_calculations(root)["calculations"] if each["name"] == "other")
    assert (other["dirty"], other["description"], other["sql"]) == (True, "Other.", "SELECT 1")


def test_a_definition_swapped_after_the_listing_is_expanded_from_the_approved_entry(root: Path) -> None:
    approve(root)
    pieces = include.Pieces(root)
    assert pieces.calcs["counts"]["dirty"] is False
    (root / "dictionaries" / "main.panel.surveys.yaml").write_text(ENTRY.replace("state = 'C'", "1 = 1"))
    assert pieces.expression("main.panel.surveys:done") == "state = 'C'"


def test_a_name_with_both_a_template_and_a_function_is_a_problem_not_a_listing(root: Path) -> None:
    (root / "trusted" / "counts.py").write_text("def counts(engine):\n    '''x'''\n")
    approve(root)
    listed = library.list_calculations(root)
    assert [each["name"] for each in listed["calculations"]] == ["main.panel.surveys:done"]
    assert listed["problems"] == [f"counts: need exactly one of counts.sql and counts.py in {root / 'trusted'}"]


def test_a_file_that_cannot_be_read_when_listed_is_a_problem_and_not_trusted(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    approve(root)
    monkeypatch.setattr(ledger_, "read_checked", lambda *_: ledger_.Read(None, False))
    listed = library.list_calculations(root)
    assert listed["calculations"] == []
    assert listed["problems"] == [
        "counts: cannot be read",
        "main.panel.surveys.yaml: cannot be read",
    ]

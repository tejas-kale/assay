"""Tests for analysis_kernel_serve's failure paths and analysis_kernel's arguments, in this process with fakes.

test_analysis_kernel.py runs the real thing in subprocesses; these are the paths a real kernel cannot be made to take.
"""

from __future__ import annotations

import json
import signal
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analysis_kernel
import analysis_kernel_serve as serving

EXIT_KERNEL_DIED = 1
EXIT_STOPPED = 0
EXIT_KERNEL_UNREACHABLE = 3


class FakeClient:
    def start_channels(self) -> None:
        pass

    def stop_channels(self) -> None:
        pass

    def wait_for_ready(self, timeout: float) -> None:
        pass

    def execute(self, code: str, **_: object) -> str:
        return "msg-1"


class FakeKernel:
    """Stands for jupyter_client's KernelManager: alive until told otherwise, never a process."""

    def __init__(self, connection_file: str = "", start: Any = None) -> None:
        self.connection_file = connection_file
        self.on_start = start
        self.shut_down = False

    def client(self) -> FakeClient:
        return FakeClient()

    def start_kernel(self, **_: object) -> None:
        if self.on_start is not None:
            self.on_start()

    def is_alive(self) -> bool:
        return False

    def shutdown_kernel(self, now: bool) -> None:
        self.shut_down = now


def events(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


@pytest.mark.parametrize(
    ("reply", "message"),
    [
        (None, "preload failed:  no reply"),
        ({"content": {"status": "error", "ename": "NameError", "evalue": "x"}}, "preload failed: NameError x"),
    ],
)
def test_a_preload_that_fails_or_never_answers_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, reply: dict[str, Any] | None, message: str
) -> None:
    monkeypatch.setattr(serving, "wait_reply", lambda *_args, **_kwargs: reply)
    with pytest.raises(RuntimeError, match=message):
        serving.run_preload(FakeKernel(), tmp_path)


def test_a_kernel_that_does_not_start_is_reported_dead(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def refuse() -> None:
        raise OSError("no such python")

    monkeypatch.setattr(serving, "is_installed", lambda: True)
    monkeypatch.setattr(serving, "stop_when_parent_dies", lambda stop: None)
    monkeypatch.setattr(serving, "KernelManager", lambda connection_file: FakeKernel(start=refuse))
    assert serving.serve(tmp_path, tmp_path / "c.json") == EXIT_KERNEL_DIED
    assert events(capsys) == [{"event": "dead", "message": "The kernel did not start: no such python"}]


def test_a_stop_during_start_ends_without_ready(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    handlers: dict[int, Any] = {}

    def record_handler(number: int, handler: Any) -> None:
        handlers[number] = handler

    monkeypatch.setattr(signal, "signal", record_handler)
    monkeypatch.setattr(serving, "is_installed", lambda: True)
    monkeypatch.setattr(serving, "stop_when_parent_dies", lambda stop: None)
    monkeypatch.setattr(serving, "run_preload", lambda km, analysis: None)

    def send_sigterm() -> None:
        handlers[signal.SIGTERM](signal.SIGTERM, None)

    kernel = FakeKernel(start=send_sigterm)
    monkeypatch.setattr(serving, "KernelManager", lambda connection_file: kernel)
    assert serving.serve(tmp_path, tmp_path / "c.json") == EXIT_STOPPED
    assert events(capsys) == [{"event": "stopped"}]
    assert kernel.shut_down


def test_run_arguments_reach_the_run_and_a_missing_kernel_exits_three(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "queries").mkdir()
    (tmp_path / "queries" / "001_x.py").write_text("1\n")
    argv = ["run", "--connection", str(tmp_path / "none.json"), "--analysis", str(tmp_path)]
    argv += ["--code-file", "queries/001_x.py", "--timeout", "5", "--serve-pid", "0"]
    assert analysis_kernel.main(argv) == EXIT_KERNEL_UNREACHABLE
    assert json.loads(capsys.readouterr().out)["error"]["name"] == "KernelUnreachable"

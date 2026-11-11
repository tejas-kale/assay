"""``analysis_kernel.py run``: executes one code file in the kernel and writes the run's files.

``run_code_file`` writes ``queries/NNN_x.json`` (atomically, every 0.5 s while running and once at the end) with
``NNN_x.tK.csv`` for each displayed table and ``NNN_x.pK.png|svg`` for each plot, then prints one JSON summary line.
``Run`` holds what the run has shown so far; ``Watch`` decides, between messages, when to write, interrupt or give up.
"""

from __future__ import annotations

import ast
import base64
import contextlib
import csv
import io
import json
import os
import queue
import re
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from analysis_kernel_preload import TABLE_MIME

try:
    from jupyter_client import BlockingKernelClient
except ImportError:  # `serve` reports a missing install; `run` has nothing to run against
    BlockingKernelClient = None

MAX_TABLES = 20
MAX_PLOTS = 20
MAX_STDOUT = 1_000_000
SUMMARY_STDOUT = 4000
SUMMARY_ROWS = 50
WRITE_EVERY = 0.5
INTERRUPT_GRACE = 8.0
FIRST_ALIVE_CHECK = 2.0
ALIVE_CHECK_EVERY = 1.0
MISSES_BEFORE_DEAD = 3
CONNECT_TIMEOUT = 15
READS_TIMEOUT = 10
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

DIED = "died"
GAVE_UP = "gave_up"


def now_ms() -> int:
    return int(time.time() * 1000)


def kernel_id(connection: str | Path) -> str:
    """The kernel's id: the connection file's name without ``.json`` and a leading ``kernel-``."""
    stem = Path(connection).stem
    return stem[len("kernel-") :] if stem.startswith("kernel-") else stem


def atomic_write(path: Path, data: bytes) -> None:
    """Writes ``path`` through a temp file ``.<name>.tmp`` in the same folder, then a rename."""
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def wait_reply(kc: Any, msg_id: str, timeout: float) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            msg = kc.get_shell_msg(timeout=0.5)
        except queue.Empty:
            continue
        if msg["parent_header"].get("msg_id") == msg_id:
            return msg
    return None


class Run:
    """What one run has shown so far, and the files it writes."""

    def __init__(self, queries: Path, base: str, kernel: str, started: int) -> None:
        self.queries = queries
        self.base = base
        self.kernel = kernel
        self.started = started
        self.status = "running"
        self.ended: int | None = None
        self.stdout = ""
        self.stdout_truncated = False
        self.error: dict[str, str] | None = None
        self.tables: list[dict[str, Any]] = []
        self.table_rows: list[list[list[str]]] = []
        self.plots: list[str] = []
        self.reads: list[int] = []

    def add_stdout(self, text: str) -> None:
        room = MAX_STDOUT - len(self.stdout)
        if len(text) > room:
            self.stdout_truncated = True
            text = text[: max(room, 0)]
        self.stdout += text

    def add_table(self, data: dict[str, Any]) -> None:
        if len(self.tables) >= MAX_TABLES:
            return
        number = len(self.tables) + 1
        name = f"{self.base}.t{number}.csv"
        text = data.get("csv", "")
        atomic_write(self.queries / name, text.encode("utf-8"))
        self.tables.append(
            {
                "file": name,
                "columns": list(data.get("columns", [])),
                "rowCount": int(data.get("rowCount", 0)),
                "truncated": bool(data.get("truncated", False)),
            }
        )
        rows = []
        for i, row in enumerate(csv.reader(io.StringIO(text))):
            if i > SUMMARY_ROWS:
                break
            if i > 0:
                rows.append(row)
        self.table_rows.append(rows)

    def add_plot(self, data: dict[str, Any]) -> None:
        if len(self.plots) >= MAX_PLOTS:
            return
        number = len(self.plots) + 1
        if "image/png" in data:
            name, content = f"{self.base}.p{number}.png", base64.b64decode(data["image/png"])
        else:
            name, content = f"{self.base}.p{number}.svg", data["image/svg+xml"].encode("utf-8")
        atomic_write(self.queries / name, content)
        self.plots.append(name)

    def handle(self, msg: dict[str, Any]) -> bool:
        """Folds in one iopub message of this run; true when the kernel is idle again."""
        kind, content = msg["msg_type"], msg["content"]
        if kind == "stream":
            self.add_stdout(content.get("text", ""))
        elif kind in ("display_data", "execute_result"):
            data = content.get("data", {})
            if TABLE_MIME in data:
                self.add_table(data[TABLE_MIME])
            elif "image/png" in data or "image/svg+xml" in data:
                self.add_plot(data)
            elif "text/plain" in data:
                self.add_stdout(data["text/plain"] + "\n")
        elif kind == "error":
            trace = ANSI.sub("", "\n".join(content.get("traceback", [])))
            self.error = {
                "name": content.get("ename", ""),
                "message": ANSI.sub("", content.get("evalue", "")),
                "traceback": trace,
            }
        elif kind == "status":
            return content.get("execution_state") == "idle"
        return False

    def result(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "status": self.status,
            "kernel": self.kernel,
            "startedAt": self.started,
        }
        if self.ended is not None:
            out["endedAt"] = self.ended
        out["stdout"] = self.stdout
        if self.stdout_truncated:
            out["stdoutTruncated"] = True
        if self.error is not None:
            out["error"] = self.error
        out["tables"] = self.tables
        out["plots"] = [{"file": f} for f in self.plots]
        out["reads"] = self.reads
        return out

    def write(self) -> None:
        atomic_write(self.queries / f"{self.base}.json", json.dumps(self.result()).encode("utf-8"))

    def summary(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": self.status, "stdout": self.stdout[-SUMMARY_STDOUT:]}
        if self.error is not None:
            out["error"] = self.error
        out["tables"] = [{**t, "rows": rows} for t, rows in zip(self.tables, self.table_rows, strict=True)]
        out["plots"] = list(self.plots)
        out["reads"] = self.reads
        out["startedAt"] = self.started
        out["endedAt"] = self.ended
        out["durationMs"] = (self.ended or now_ms()) - self.started
        return out


def fetch_reads(kc: Any) -> list[int]:
    """Reads and clears the numbers ``q`` recorded since the last call."""
    msg_id = kc.execute(
        "",
        silent=True,
        store_history=False,
        user_expressions={"reads": "__import__('_assay_runtime').pop_reads()"},
    )
    reply = wait_reply(kc, msg_id, timeout=READS_TIMEOUT)
    if reply is None:
        return []
    try:
        shown = reply["content"]["user_expressions"]["reads"]["data"]["text/plain"]
        return [int(n) for n in ast.literal_eval(shown)]
    except (KeyError, ValueError, SyntaxError):
        return []


class Watch:
    """The clock of one run: when to rewrite the json, interrupt a run past its timeout, and give up on the kernel."""

    def __init__(self, timeout: float, serve_pid: int) -> None:
        now = time.monotonic()
        self.serve_pid = serve_pid
        self.deadline = now + timeout
        self.next_write = now + WRITE_EVERY
        self.next_alive = now + FIRST_ALIVE_CHECK
        self.interrupted_at: float | None = None
        self.misses = 0

    def tick(self, kc: Any, this: Run) -> str | None:
        """Does what is due; ``DIED`` or ``GAVE_UP`` when the run must end without the kernel's own idle."""
        now = time.monotonic()
        if now >= self.next_write:
            this.write()
            self.next_write = now + WRITE_EVERY
        if self.interrupted_at is None and now >= self.deadline:
            self.interrupted_at = now
            self.interrupt()
        if self.interrupted_at is not None and now - self.interrupted_at > INTERRUPT_GRACE:
            return GAVE_UP
        if now >= self.next_alive:
            self.next_alive = now + ALIVE_CHECK_EVERY
            self.misses = 0 if kc.is_alive() else self.misses + 1
            if self.misses >= MISSES_BEFORE_DEAD:
                return DIED
        return None

    def interrupt(self) -> None:
        if self.serve_pid > 0:  # 0 or less would signal a whole process group
            with contextlib.suppress(OSError):
                os.kill(self.serve_pid, signal.SIGUSR1)


def watch_until_done(kc: Any, this: Run, msg_id: str, watch: Watch) -> str | None:
    """Folds the run's messages into ``this`` until the kernel is idle (None) or the run must end (the verdict)."""
    while True:
        try:
            msg = kc.get_iopub_msg(timeout=0.1)
        except queue.Empty:
            msg = None
        if msg is not None and msg["parent_header"].get("msg_id") == msg_id and this.handle(msg):
            return None
        verdict = watch.tick(kc, this)
        if verdict is not None:
            return verdict


def settle(this: Run, verdict: str | None) -> None:
    """Sets the run's status, and its error when the kernel did not report one itself."""
    if verdict == DIED:
        this.status = "error"
        this.error = {"name": "KernelDied", "message": "The kernel stopped answering during the run.", "traceback": ""}
    elif verdict == GAVE_UP:
        this.status = "interrupted"
        this.error = {
            "name": "KeyboardInterrupt",
            "message": "The run did not stop after the interrupt.",
            "traceback": "",
        }
    elif this.error is not None:
        this.status = "interrupted" if this.error["name"] == "KeyboardInterrupt" else "error"
    else:
        this.status = "ok"


@dataclass(frozen=True)
class RunRequest:
    """``analysis_kernel.py run``'s arguments."""

    connection: Path
    analysis: Path
    code_file: str
    timeout: float
    serve_pid: int


def finish(this: Run) -> None:
    this.ended = now_ms()
    this.write()
    print(json.dumps(this.summary()), flush=True)


def connect(connection: Path) -> Any:
    """A client with its channels started; raises when the kernel cannot be reached."""
    kc = BlockingKernelClient(connection_file=str(connection))
    try:
        kc.load_connection_file()
        kc.start_channels()
        kc.wait_for_ready(timeout=CONNECT_TIMEOUT)
    except Exception:
        kc.stop_channels()
        raise
    return kc


def execute(kc: Any, this: Run, code: str, request: RunRequest) -> None:
    fetch_reads(kc)  # a stale list from a client that stopped early
    msg_id = kc.execute(code, silent=False, store_history=True, allow_stdin=False)
    verdict = watch_until_done(kc, this, msg_id, Watch(request.timeout, request.serve_pid))
    settle(this, verdict)
    if verdict is None:
        this.reads = fetch_reads(kc)


def run_code_file(request: RunRequest) -> int:
    path = (request.analysis / request.code_file).resolve()
    base = path.name[: -len(".py")] if path.name.endswith(".py") else path.stem
    this = Run(path.parent, base, kernel_id(request.connection), now_ms())
    this.write()
    code = path.read_text(encoding="utf-8")
    try:
        kc = connect(request.connection)
    except Exception as exc:
        this.status = "error"
        message = f"The kernel could not be reached: {exc}"
        this.error = {"name": "KernelUnreachable", "message": message, "traceback": ""}
        finish(this)
        return 3
    try:
        execute(kc, this, code, request)
    finally:
        kc.stop_channels()
    finish(this)
    return 0

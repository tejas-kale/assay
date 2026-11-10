"""Assay's Python kernel: one long-lived kernel per session and a short client per run.

    python analysis_kernel.py serve --analysis <dir> --connection <file>
    python analysis_kernel.py run --connection <file> --analysis <dir> --code-file queries/NNN_x.py
                                  --timeout <s> --serve-pid <pid>

``serve`` starts an ipykernel (cwd ``<dir>``, connection file ``<file>``), runs the preload in it and prints one
JSON event per line on stdout, flushed: ``ready`` (``kernel``, ``pid``), ``interrupted``, ``stopped``, ``dead``
(``message``) or ``missing`` (``message``). ``SIGUSR1`` interrupts the kernel; ``SIGTERM``, ``SIGHUP`` or the parent process
dying (checked about once a second) shut it down (exit 0). Stdin is not watched: the server gives a child a closed stdin. The kernel dying by itself exits 1; no ``ipykernel`` exits 2.

``run`` executes the code file's text in that kernel and writes ``queries/NNN_x.json`` (atomically, every 0.5 s while
running and once at the end) with ``NNN_x.tK.csv`` for each displayed table and ``NNN_x.pK.png|svg`` for each plot,
then prints one JSON summary line. It exits 0 whenever the run was carried out, whatever its status; 3 when the
kernel could not be reached. Format of the files: ``docs/slice-3.md`` in the Assay repo.

This file lives in the Assay repo (``python/``); Assay's MCP server runs it by path (``$ASSAY_BACKEND/python``), under
the kernel python (a project ``.venv`` that has ipykernel, else Assay's venv, ``$ASSAY_VENV``). Only the standard library, ``jupyter_client`` and ``ipykernel`` are imported (pandas, polars and
matplotlib are used in the kernel when the user's code has them).
"""

from __future__ import annotations

import argparse
import ast
import base64
import csv
import importlib.util
import io
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

TABLE_MIME = "application/vnd.assay.table+json"
MAX_TABLES = 20
MAX_PLOTS = 20
MAX_ROWS = 100_000
MAX_STDOUT = 1_000_000
SUMMARY_STDOUT = 4000
SUMMARY_ROWS = 50
WRITE_EVERY = 0.5
INTERRUPT_GRACE = 8.0
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

MISSING_MESSAGE = "ipykernel is not installed in this Python. Assay's venv has it: open Settings and see the Doctor."


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


# ---------------------------------------------------------------------------
# The preload: runs once in the kernel, in the user's namespace.

PRELOAD = r'''
def _assay_setup(analysis_dir, table_mime, row_cap):
    import glob, json, os, re, sys, types

    os.chdir(analysis_dir)
    while analysis_dir in sys.path:
        sys.path.remove(analysis_dir)
    sys.path.insert(0, analysis_dir)
    queries = os.path.join(analysis_dir, "queries")
    reads = []

    def pop_reads():
        found = list(reads)
        reads.clear()
        return found

    def step_csv(n, step, sql):
        """The csv of step ``step`` (its number k or its name) of SQL run n, or None. The last step, ``final``, is the run's own."""
        prefix = glob.escape(os.path.join(queries, "%03d." % n))
        found = {}
        for path in sorted(glob.glob(prefix + "*.csv")):
            match = re.match(r"^(\d+)_(.+)\.csv$", os.path.basename(path)[len("%03d." % n):])
            if match:
                found[int(match.group(1))] = (match.group(2), path)
        try:
            names = [each.get("name") for each in json.load(open(os.path.join(queries, "%03d.steps.json" % n)))["steps"]]
        except Exception:
            names = []
        if isinstance(step, str):
            slug = re.sub(r"[^A-Za-z0-9_-]", "_", step)
            hits = [path for name, path in found.values() if name == slug]
            if hits:
                return hits[0]
            return sql if step == "final" and "final" in names else None
        if step in found:
            return found[step][1]
        return sql if names and step == len(names) and names[-1] == "final" else None

    def q(n, k=1, step=None):
        """Run n's saved result as a pandas DataFrame: a SQL run's csv, or table k of a Python run.

        ``step`` (a SQL run's step number or name, from the Steps tab) reads that step's result instead.
        """
        import pandas as pd

        n, k = int(n), int(k)
        prefix = glob.escape(os.path.join(queries, "%03d_" % n))
        files = sorted(glob.glob(prefix + "*.csv"))
        sql = [f for f in files if not re.search(r"\.t\d+\.csv$", f)]
        if step is not None:
            path = step_csv(n, step, sql[0] if sql else None)
            if path is None:
                raise LookupError("Run %03d has no step %s" % (n, step))
        elif sql:
            if k != 1:
                raise LookupError("Run %03d is a SQL run: it has one result" % n)
            path = sql[0]
        else:
            tables = sorted(glob.glob(prefix + "*.t%d.csv" % k))
            if not tables:
                if files:
                    raise LookupError("Run %03d has no table %d" % (n, k))
                raise LookupError("Run %03d has no saved result" % n)
            path = tables[0]
        # An empty .csv is a SQL statement that ran but returned no result set (CREATE VIEW, DROP).
        frame = pd.DataFrame() if os.path.getsize(path) == 0 else pd.read_csv(path)
        if n not in reads:
            reads.append(n)
        return frame

    runtime = types.ModuleType("_assay_runtime")
    runtime.pop_reads = pop_reads
    sys.modules["_assay_runtime"] = runtime
    get_ipython().user_ns["q"] = q

    def payload(columns, text, total):
        return {"columns": [str(c) for c in columns], "csv": text, "rowCount": int(total), "truncated": total > row_cap}

    def pandas_frame(frame):
        import pandas as pd

        total = len(frame)
        if isinstance(frame.columns, pd.MultiIndex):
            frame = frame.copy()
            frame.columns = [" ".join(map(str, c)) for c in frame.columns]
        index = True
        if not isinstance(frame.index, pd.RangeIndex):
            try:
                frame = frame.reset_index()
                index = False
            except ValueError:
                pass
        else:
            index = False
        head = frame.head(row_cap)
        return payload(head.columns, head.to_csv(index=index), total)

    def pandas_series(series):
        return pandas_frame(series.to_frame(name="value" if series.name is None else series.name))

    def polars_frame(frame):
        head = frame.head(row_cap)
        return payload(frame.columns, head.write_csv(), frame.height)

    def polars_series(series):
        return polars_frame(series.to_frame() if series.name else series.alias("value").to_frame())

    from IPython.core.formatters import BaseFormatter
    from traitlets import ObjectName, Unicode

    # Matched by (top-level package, class name) over the MRO: the defining module of pandas' classes
    # changes between versions, and subclasses should show as tables too.
    handlers = {
        ("pandas", "DataFrame"): pandas_frame,
        ("pandas", "Series"): pandas_series,
        ("polars", "DataFrame"): polars_frame,
        ("polars", "Series"): polars_series,
    }

    class TableFormatter(BaseFormatter):
        format_type = Unicode(table_mime)
        print_method = ObjectName("_repr_assay_table_")
        _return_type = (dict,)

        def __call__(self, obj):
            for cls in type(obj).__mro__:
                handler = handlers.get((cls.__module__.split(".")[0], cls.__name__))
                if handler is not None:
                    try:
                        return handler(obj)
                    except Exception:
                        return None
            return None

    display_formatter = get_ipython().display_formatter
    formatter = TableFormatter(parent=display_formatter)
    display_formatter.formatters[table_mime] = formatter
    if table_mime not in display_formatter.active_types:
        display_formatter.active_types.append(table_mime)

    try:
        get_ipython().run_line_magic("matplotlib", "inline")
    except Exception:
        pass


_assay_setup(__ANALYSIS__, __MIME__, __CAP__)
del _assay_setup
'''


def preload_code(analysis: Path) -> str:
    return PRELOAD.replace("__ANALYSIS__", repr(str(analysis))).replace("__MIME__", repr(TABLE_MIME)).replace("__CAP__", str(MAX_ROWS))


# ---------------------------------------------------------------------------
# serve


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event), flush=True)


def serve(analysis: Path, connection: Path) -> int:
    if importlib.util.find_spec("ipykernel") is None or importlib.util.find_spec("jupyter_client") is None:
        emit({"event": "missing", "message": MISSING_MESSAGE})
        return 2

    from jupyter_client import KernelManager

    stop = threading.Event()
    interrupt = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGHUP, lambda *_: stop.set())
    signal.signal(signal.SIGUSR1, lambda *_: interrupt.set())

    parent = os.getppid()

    def watch_parent() -> None:
        while not stop.wait(1.0):
            if os.getppid() != parent:
                stop.set()

    threading.Thread(target=watch_parent, daemon=True).start()

    connection.parent.mkdir(parents=True, exist_ok=True)
    km = KernelManager(connection_file=str(connection))
    dead_message: str | None = None
    try:
        km.start_kernel(cwd=str(analysis), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run_preload(km, analysis)
    except Exception as exc:
        dead_message = f"The kernel did not start: {exc}"

    if dead_message is None and not stop.is_set():
        emit({"event": "ready", "kernel": kernel_id(connection), "pid": os.getpid()})
        while not stop.is_set():
            if interrupt.is_set():
                interrupt.clear()
                try:
                    km.interrupt_kernel()
                except Exception:
                    pass
                emit({"event": "interrupted"})
            if not km.is_alive():
                code = km.provisioner.process.poll() if getattr(km, "provisioner", None) else None
                dead_message = "The kernel process exited" + (f" (code {code})." if code is not None else ".")
                break
            stop.wait(0.1)

    try:
        km.shutdown_kernel(now=True)
    except Exception:
        pass
    if dead_message is not None:
        emit({"event": "dead", "message": dead_message})
        return 1
    emit({"event": "stopped"})
    return 0


def run_preload(km: Any, analysis: Path) -> None:
    """Runs the preload in the kernel and raises when it fails."""
    kc = km.client()
    kc.start_channels()
    try:
        kc.wait_for_ready(timeout=60)
        msg_id = kc.execute(preload_code(analysis), silent=True, store_history=False)
        reply = wait_reply(kc, msg_id, timeout=120)
        if reply is None or reply["content"].get("status") != "ok":
            content = (reply or {}).get("content", {})
            raise RuntimeError(f"preload failed: {content.get('ename', '')} {content.get('evalue', 'no reply')}".strip())
    finally:
        kc.stop_channels()


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


# ---------------------------------------------------------------------------
# run


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
        out["tables"] = [{**t, "rows": rows} for t, rows in zip(self.tables, self.table_rows)]
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
    reply = wait_reply(kc, msg_id, timeout=10)
    if reply is None:
        return []
    try:
        shown = reply["content"]["user_expressions"]["reads"]["data"]["text/plain"]
        return [int(n) for n in ast.literal_eval(shown)]
    except (KeyError, ValueError, SyntaxError):
        return []


def run(connection: Path, analysis: Path, code_file: str, timeout: float, serve_pid: int) -> int:
    from jupyter_client import BlockingKernelClient

    path = (analysis / code_file).resolve()
    base = path.name[: -len(".py")] if path.name.endswith(".py") else path.stem
    this = Run(path.parent, base, kernel_id(connection), now_ms())
    this.write()
    code = path.read_text(encoding="utf-8")

    kc = BlockingKernelClient(connection_file=str(connection))
    try:
        kc.load_connection_file()
        kc.start_channels()
        kc.wait_for_ready(timeout=15)
    except Exception as exc:
        kc.stop_channels()
        this.status = "error"
        this.ended = now_ms()
        this.error = {"name": "KernelUnreachable", "message": f"The kernel could not be reached: {exc}", "traceback": ""}
        this.write()
        print(json.dumps(this.summary()), flush=True)
        return 3

    try:
        fetch_reads(kc)  # a stale list from a client that stopped early
        msg_id = kc.execute(code, silent=False, store_history=True, allow_stdin=False)
        interrupted_at: float | None = None
        gave_up = False
        died = False
        deadline = time.monotonic() + timeout
        next_write = time.monotonic() + WRITE_EVERY
        next_alive = time.monotonic() + 2.0
        misses = 0
        while True:
            try:
                msg = kc.get_iopub_msg(timeout=0.1)
            except queue.Empty:
                msg = None
            if msg is not None and msg["parent_header"].get("msg_id") == msg_id and this.handle(msg):
                break
            now = time.monotonic()
            if now >= next_write:
                this.write()
                next_write = now + WRITE_EVERY
            if interrupted_at is None and now >= deadline:
                interrupted_at = now
                if serve_pid > 0:  # 0 or less would signal a whole process group
                    try:
                        os.kill(serve_pid, signal.SIGUSR1)
                    except OSError:
                        pass
            if interrupted_at is not None and now - interrupted_at > INTERRUPT_GRACE:
                gave_up = True
                break
            if now >= next_alive:
                next_alive = now + 1.0
                misses = 0 if kc.is_alive() else misses + 1
                if misses >= 3:
                    died = True
                    break
        if died:
            this.status = "error"
            this.error = {"name": "KernelDied", "message": "The kernel stopped answering during the run.", "traceback": ""}
        elif gave_up:
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
        if not died and not gave_up:
            this.reads = fetch_reads(kc)
    finally:
        kc.stop_channels()
    this.ended = now_ms()
    this.write()
    print(json.dumps(this.summary()), flush=True)
    return 0


# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="analysis_kernel", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    s = commands.add_parser("serve")
    s.add_argument("--analysis", required=True)
    s.add_argument("--connection", required=True)
    r = commands.add_parser("run")
    r.add_argument("--connection", required=True)
    r.add_argument("--analysis", required=True)
    r.add_argument("--code-file", required=True)
    r.add_argument("--timeout", type=float, required=True)
    r.add_argument("--serve-pid", type=int, required=True)
    args = parser.parse_args(argv)
    if args.command == "serve":
        return serve(Path(args.analysis).resolve(), Path(args.connection))
    return run(Path(args.connection), Path(args.analysis), args.code_file, args.timeout, args.serve_pid)


if __name__ == "__main__":
    sys.exit(main())

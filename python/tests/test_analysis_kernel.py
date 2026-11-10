"""Tests for analysis_kernel, against real kernels: <venv>/bin/python -m pytest python/tests/test_analysis_kernel.py

The venv needs ipykernel, jupyter_client, pandas, polars, pyarrow, matplotlib and pytest.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Iterator

import pytest

HERE = Path(__file__).resolve().parents[1]
SCRIPT = HERE / "analysis_kernel.py"
DEADLINE = 90.0


class Serve:
    """A running ``serve`` process: its stdout events, read on a thread so every wait has a deadline."""

    def __init__(self, analysis: Path, connection: Path, python: list[str] | None = None) -> None:
        cmd = python or [sys.executable, str(SCRIPT)]
        self.proc = subprocess.Popen(
            [*cmd, "serve", "--analysis", str(analysis), "--connection", str(connection)],
            stdin=subprocess.DEVNULL,  # as the mod starts it: a closed stdin
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.events: queue.Queue[dict[str, Any] | None] = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.events.put(json.loads(line))  # a line that is not JSON fails the reader loudly
        self.events.put(None)

    def event(self, timeout: float = DEADLINE) -> dict[str, Any] | None:
        return self.events.get(timeout=timeout)

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream:
                stream.close()


class Analysis:
    """An analysis folder with a kernel behind it, and a helper that runs code as the next numbered run."""

    def __init__(self, folder: Path, connection: Path, serve: Serve) -> None:
        self.dir = folder
        self.connection = connection
        self.serve = serve
        self.counter = 0

    def command(self, code_file: str, timeout: float = 60) -> list[str]:
        return [
            sys.executable,
            str(SCRIPT),
            "run",
            "--connection",
            str(self.connection),
            "--analysis",
            str(self.dir),
            "--code-file",
            code_file,
            "--timeout",
            str(timeout),
            "--serve-pid",
            str(self.serve.proc.pid),
        ]

    def next_file(self, code: str) -> str:
        self.counter += 1
        name = f"queries/{self.counter:03d}_x.py"
        (self.dir / name).write_text(code)
        return name

    def run(self, code: str, timeout: float = 60) -> dict[str, Any]:
        done = subprocess.run(self.command(self.next_file(code), timeout), capture_output=True, text=True, timeout=DEADLINE)
        assert done.returncode == 0, done.stderr
        lines = done.stdout.strip().splitlines()
        assert len(lines) == 1, done.stdout
        return json.loads(lines[0])

    def result(self, number: int | None = None) -> dict[str, Any]:
        number = number or self.counter
        return json.loads((self.dir / "queries" / f"{number:03d}_x.json").read_text())

    def path(self, name: str) -> Path:
        return self.dir / "queries" / name


def start(tmp_path: Path) -> Iterator[Analysis]:
    folder = tmp_path / "analysis"
    (folder / "queries").mkdir(parents=True)
    connection = tmp_path / "tmp" / "kernel-abc123.json"
    serve = Serve(folder, connection)
    try:
        ready = serve.event()
        assert ready is not None and ready["event"] == "ready", ready
        assert ready["kernel"] == "abc123" and ready["pid"] == serve.proc.pid
        yield Analysis(folder, connection, serve)
    finally:
        serve.stop()


@pytest.fixture(scope="module")
def kernel(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Analysis]:
    yield from start(tmp_path_factory.mktemp("kernel"))


@pytest.fixture
def fresh(tmp_path: Path) -> Iterator[Analysis]:
    yield from start(tmp_path)


def test_a_print_and_an_expression_land_in_stdout(kernel: Analysis) -> None:
    summary = kernel.run("print('hello')\n1 + 1\n")
    assert summary["status"] == "ok"
    assert summary["stdout"] == "hello\n2\n"
    result = kernel.result()
    assert result["status"] == "ok"
    assert result["stdout"] == "hello\n2\n"
    assert result["kernel"] == "abc123"
    assert result["endedAt"] >= result["startedAt"]
    assert "error" not in result and result["tables"] == [] and result["plots"] == [] and result["reads"] == []


def test_the_code_file_may_carry_header_comments(kernel: Analysis) -> None:
    assert kernel.run("# author: user\n# from: 001\nprint('ran')\n")["stdout"] == "ran\n"


def test_a_dataframe_becomes_a_table_file(kernel: Analysis) -> None:
    summary = kernel.run("import pandas as pd\npd.DataFrame({'a': [1, 2, 3], 'b': ['x', 'y', 'z']})\n")
    assert summary["stdout"] == ""  # a table is not repeated as text
    table = summary["tables"][0]
    assert table["file"] == f"{kernel.counter:03d}_x.t1.csv"
    assert table["columns"] == ["a", "b"] and table["rowCount"] == 3 and table["truncated"] is False
    assert table["rows"] == [["1", "x"], ["2", "y"], ["3", "z"]]
    assert kernel.path(table["file"]).read_text() == "a,b\n1,x\n2,y\n3,z\n"
    assert kernel.result()["tables"] == [{k: v for k, v in table.items() if k != "rows"}]


def test_display_shows_several_tables_in_order_and_series_and_polars_work(kernel: Analysis) -> None:
    summary = kernel.run(
        "import pandas as pd, polars as pl\n"
        "display(pd.Series([1, 2], name='n'))\n"
        "display(pl.DataFrame({'p': [1, 2]}))\n"
        "display(pl.Series('s', [5]))\n"
        "pd.DataFrame({'v': [1, 2]}, index=pd.Index(['k1', 'k2'], name='key'))\n"
    )
    assert summary["status"] == "ok", summary
    assert [t["columns"] for t in summary["tables"]] == [["n"], ["p"], ["s"], ["key", "v"]]
    assert [t["file"][-6:] for t in summary["tables"]] == ["t1.csv", "t2.csv", "t3.csv", "t4.csv"]
    assert kernel.path(summary["tables"][3]["file"]).read_text() == "key,v\nk1,1\nk2,2\n"


def test_the_row_cap_truncates_the_csv_and_keeps_the_count(kernel: Analysis) -> None:
    summary = kernel.run("import pandas as pd\npd.DataFrame({'a': range(100_050)})\n")
    table = summary["tables"][0]
    assert table["rowCount"] == 100_050 and table["truncated"] is True
    assert len(kernel.path(table["file"]).read_text().splitlines()) == 100_001
    assert len(table["rows"]) == 50


def test_at_most_twenty_tables_and_plots_are_kept(kernel: Analysis) -> None:
    summary = kernel.run(
        "import pandas as pd, matplotlib.pyplot as plt\n"
        "for i in range(22):\n"
        "    display(pd.DataFrame({'i': [i]}))\n"
        "    fig = plt.figure(); plt.plot([i]); plt.show()\n"
    )
    assert len(summary["tables"]) == 20 and len(summary["plots"]) == 20
    assert not kernel.path(f"{kernel.counter:03d}_x.t21.csv").exists()


def test_a_figure_becomes_a_png(kernel: Analysis) -> None:
    summary = kernel.run("import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\n")
    assert summary["plots"] == [f"{kernel.counter:03d}_x.p1.png"]
    assert kernel.path(summary["plots"][0]).read_bytes().startswith(b"\x89PNG")
    assert kernel.result()["plots"] == [{"file": summary["plots"][0]}]
    assert "Figure" not in summary["stdout"]


def test_svg_only_output_becomes_an_svg(kernel: Analysis) -> None:
    summary = kernel.run(
        "from IPython.display import SVG, display\n"
        "display(SVG('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"4\" height=\"4\"></svg>'))\n"
    )
    assert summary["plots"] == [f"{kernel.counter:03d}_x.p1.svg"]
    assert kernel.path(summary["plots"][0]).read_text().startswith("<svg")


def test_an_exception_gives_a_plain_traceback(kernel: Analysis) -> None:
    summary = kernel.run("d = {}\nd['x']\n")
    assert summary["status"] == "error"
    error = summary["error"]
    assert error["name"] == "KeyError" and error["message"] == "'x'"
    assert "KeyError" in error["traceback"] and "\x1b" not in error["traceback"]
    assert kernel.result()["status"] == "error" and kernel.result()["error"] == error


def test_state_persists_between_runs(kernel: Analysis) -> None:
    kernel.run("persisted = 41\n")
    assert kernel.run("persisted + 1\n")["stdout"] == "42\n"


def test_stdout_past_a_megabyte_is_cut_and_marked(kernel: Analysis) -> None:
    summary = kernel.run("print('x' * 1_200_000)\n")
    result = kernel.result()
    assert result["stdoutTruncated"] is True and len(result["stdout"]) == 1_000_000
    assert len(summary["stdout"]) == 4000


def test_the_analysis_folder_is_cwd_and_first_on_the_path(kernel: Analysis) -> None:
    (kernel.dir / "lib").mkdir(exist_ok=True)
    (kernel.dir / "lib" / "__init__.py").write_text("")
    (kernel.dir / "lib" / "helpers.py").write_text("ANSWER = 42\n")
    summary = kernel.run("import os\nfrom lib.helpers import ANSWER\nprint(ANSWER)\nprint(os.path.basename(os.getcwd()))\n")
    assert summary["status"] == "ok", summary
    assert summary["stdout"].splitlines() == ["42", "analysis"]


def test_q_reads_a_sql_csv_and_a_python_table_and_records_the_reads(kernel: Analysis) -> None:
    (kernel.dir / "queries" / "090_sales.csv").write_text("id,total\n1,10\n2,20\n")
    (kernel.dir / "queries" / "090_sales.json").write_text("{}")
    kernel.run("import pandas as pd\ndisplay(pd.DataFrame({'a': [7]}))\ndisplay(pd.DataFrame({'b': [8, 9]}))\n")
    python_run = kernel.counter
    summary = kernel.run(
        f"s = q(90)\nt1 = q({python_run})\nt2 = q({python_run}, 2)\nq(90)\n"
        "print(type(s).__module__.split('.')[0], list(s.columns), int(s.total.sum()), t1.a[0], list(t2.b))\n"
    )
    assert summary["status"] == "ok", summary
    assert summary["stdout"].endswith("pandas ['id', 'total'] 30 7 [8, 9]\n")
    assert summary["reads"] == [90, python_run]
    assert kernel.result()["reads"] == [90, python_run]
    assert kernel.run("1")["reads"] == []  # cleared after each run


def test_q_of_a_sql_run_with_no_result_set_is_an_empty_frame(kernel: Analysis) -> None:
    (kernel.dir / "queries" / "078_probe-view.sql").write_text("CREATE OR REPLACE TEMPORARY VIEW v AS SELECT 1 AS x\n")
    (kernel.dir / "queries" / "078_probe-view.csv").write_text("")
    summary = kernel.run("e = q(78)\nprint(type(e).__name__, e.shape)\n")
    assert summary["status"] == "ok", summary
    assert summary["stdout"] == "DataFrame (0, 0)\n"
    assert summary["reads"] == [78]


def test_q_with_no_saved_result_raises_lookup_error(kernel: Analysis) -> None:
    summary = kernel.run("q(77)\n")
    assert summary["status"] == "error"
    assert summary["error"]["name"] == "LookupError"
    assert summary["error"]["message"] == "Run 077 has no saved result"
    assert summary["reads"] == []


def test_q_step_reads_a_steps_csv_by_number_or_name_and_final_is_the_runs_own(kernel: Analysis) -> None:
    queries = kernel.dir / "queries"
    (queries / "095_spend.csv").write_text("id\n1\n")
    (queries / "095.1_orders_clean.csv").write_text("a\n10\n20\n")
    (queries / "095.2_orders_by_day.csv").write_text("a\n5\n")
    (queries / "095.steps.json").write_text(json.dumps({"steps": [{"name": "orders_clean"}, {"name": "orders_by_day"}, {"name": "final"}]}))
    summary = kernel.run("a = q(95, step=1)\nb = q(95, step='orders_by_day')\nc = q(95, step=3)\nd = q(95, step='final')\nprint(len(a), len(b), list(c.id), list(d.id))\n")
    assert summary["status"] == "ok", summary
    assert summary["stdout"].endswith("2 1 [1] [1]\n")
    assert summary["reads"] == [95]


def test_q_step_that_does_not_exist_raises_lookup_error(kernel: Analysis) -> None:
    (kernel.dir / "queries" / "096_spend.csv").write_text("id\n1\n")
    for call, message in (("q(96, step=3)", "Run 096 has no step 3"), ("q(96, step='nope')", "Run 096 has no step nope"), ("q(97, step=1)", "Run 097 has no step 1")):
        summary = kernel.run(call + "\n")
        assert summary["status"] == "error" and summary["error"]["name"] == "LookupError"
        assert summary["error"]["message"] == message


def wait_for_status(target: Path, status: str) -> bool:
    deadline = time.monotonic() + DEADLINE
    while time.monotonic() < deadline:
        if target.exists() and json.loads(target.read_text())["status"] == status:  # never a half-written file
            return True
        time.sleep(0.05)
    return False


def test_the_json_is_rewritten_while_running_with_stdout_so_far(kernel: Analysis) -> None:
    code_file = kernel.next_file("import time\nprint('early', flush=True)\ntime.sleep(3)\n")
    proc = subprocess.Popen(kernel.command(code_file), stdout=subprocess.PIPE, text=True)
    target = kernel.path(f"{kernel.counter:03d}_x.json")
    assert wait_for_status(target, "running")
    deadline = time.monotonic() + DEADLINE
    while time.monotonic() < deadline and json.loads(target.read_text())["stdout"] != "early\n":
        time.sleep(0.05)
    running = json.loads(target.read_text())
    assert running["status"] == "running" and running["stdout"] == "early\n" and "endedAt" not in running
    proc.communicate(timeout=DEADLINE)
    assert kernel.result()["status"] == "ok"
    assert not list((kernel.dir / "queries").glob(".*.tmp"))


def test_a_run_past_the_timeout_ends_interrupted_and_the_kernel_still_answers(kernel: Analysis) -> None:
    summary = kernel.run("import time\ntime.sleep(60)\n", timeout=1)
    assert summary["status"] == "interrupted"
    assert kernel.result()["status"] == "interrupted"
    assert summary["error"]["name"] == "KeyboardInterrupt"
    assert kernel.run("print('alive')\n")["stdout"] == "alive\n"


def test_a_run_against_no_kernel_exits_non_zero_with_an_error_file(tmp_path: Path) -> None:
    folder = tmp_path / "a"
    (folder / "queries").mkdir(parents=True)
    (folder / "queries" / "001_x.py").write_text("1\n")
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "run", "--connection", str(tmp_path / "nope.json"), "--analysis", str(folder),
         "--code-file", "queries/001_x.py", "--timeout", "5", "--serve-pid", "1"],
        capture_output=True, text=True, timeout=DEADLINE,
    )
    assert done.returncode != 0
    assert json.loads(done.stdout)["error"]["name"] == "KernelUnreachable"
    assert json.loads((folder / "queries" / "001_x.json").read_text())["status"] == "error"


def test_serve_interrupts_on_sigusr1_and_stops_on_sigterm(fresh: Analysis) -> None:
    code_file = fresh.next_file("import time\nprint('go', flush=True)\ntime.sleep(60)\n")
    proc = subprocess.Popen(fresh.command(code_file), stdout=subprocess.PIPE, text=True)
    target = fresh.path("001_x.json")
    deadline = time.monotonic() + DEADLINE
    while time.monotonic() < deadline and not (target.exists() and "go" in json.loads(target.read_text())["stdout"]):
        time.sleep(0.05)
    os.kill(fresh.serve.proc.pid, signal.SIGUSR1)
    assert fresh.serve.event() == {"event": "interrupted"}
    out, _ = proc.communicate(timeout=DEADLINE)
    assert json.loads(out)["status"] == "interrupted"
    fresh.serve.proc.send_signal(signal.SIGTERM)
    assert fresh.serve.event() == {"event": "stopped"}
    assert fresh.serve.proc.wait(timeout=30) == 0


def test_serve_stops_cleanly_on_sighup(fresh: Analysis) -> None:
    fresh.serve.proc.send_signal(signal.SIGHUP)
    assert fresh.serve.event() == {"event": "stopped"}
    assert fresh.serve.proc.wait(timeout=30) == 0
    assert fresh.serve.event() is None  # no stray output after the event


def test_serve_with_a_closed_stdin_stays_up_and_runs_code(fresh: Analysis) -> None:
    time.sleep(2.5)  # past a few parent checks
    assert fresh.serve.proc.poll() is None
    assert fresh.serve.events.empty()
    assert fresh.run("print(6 * 7)")["stdout"].strip() == "42"


def running(pid: int) -> bool:
    """Whether the process runs. A zombie has stopped: where PID 1 does not reap orphans (a container started
    without an init), the stopped serve stays one."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    stat = Path(f"/proc/{pid}/stat")
    return not (stat.exists() and stat.read_text().rsplit(")", 1)[1].split()[0] == "Z")


def test_serve_stops_when_its_parent_dies(tmp_path: Path) -> None:
    out = tmp_path / "events.txt"
    launcher = (
        "import subprocess, sys\n"
        f"p = subprocess.Popen([sys.executable, {str(SCRIPT)!r}, 'serve', '--analysis', {str(tmp_path)!r},"
        f" '--connection', {str(tmp_path / 'c.json')!r}], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdout=open({str(out)!r}, 'w'))\n"
        f"import time\nwhile 'ready' not in open({str(out)!r}).read():\n    time.sleep(0.1)\n"  # the parent must be recorded first
        "print(p.pid, flush=True)\n"
    )
    done = subprocess.run([sys.executable, "-c", launcher], capture_output=True, text=True, check=True)
    pid = int(done.stdout.strip())  # the launcher has exited: serve is orphaned
    deadline = time.monotonic() + DEADLINE
    try:
        while time.monotonic() < deadline:
            if not running(pid):
                break
            time.sleep(0.2)
        else:
            pytest.fail("serve kept running after its parent died")
        assert '"stopped"' in out.read_text()
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_a_serve_pid_of_zero_signals_nobody(fresh: Analysis) -> None:
    code_file = fresh.next_file("import time\ntime.sleep(60)\n")
    cmd = fresh.command(code_file)
    cmd[cmd.index("--serve-pid") + 1] = "0"
    cmd[cmd.index("--timeout") + 1] = "1"
    started = time.monotonic()
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=DEADLINE)
    assert json.loads(done.stdout)["status"] in ("error", "interrupted")  # gave up after the grace, no signal sent
    assert time.monotonic() - started < DEADLINE
    assert fresh.serve.events.empty()  # serve was never interrupted


def test_serve_reports_a_kernel_that_dies_by_itself(fresh: Analysis) -> None:
    pids = subprocess.run(["pgrep", "-P", str(fresh.serve.proc.pid)], capture_output=True, text=True).stdout.split()
    assert pids
    for pid in pids:
        os.kill(int(pid), signal.SIGKILL)
    event = fresh.serve.event()
    assert event is not None and event["event"] == "dead" and event["message"]
    assert fresh.serve.proc.wait(timeout=30) == 1


def test_serve_says_missing_when_ipykernel_is_not_installed(tmp_path: Path) -> None:
    shim = (
        "import sys, runpy\n"
        "sys.modules['ipykernel'] = None\n"
        f"sys.argv = [{str(SCRIPT)!r}, *sys.argv[1:]]\n"
        f"runpy.run_path({str(SCRIPT)!r}, run_name='__main__')\n"
    )
    serve = Serve(tmp_path, tmp_path / "c.json", python=[sys.executable, "-c", shim])
    try:
        event = serve.event()
        assert event is not None and event["event"] == "missing"
        assert event["message"] == (
            "ipykernel is not installed in this Python. Assay's venv has it: open Settings and see the Doctor."
        )
        assert serve.proc.wait(timeout=30) == 2
    finally:
        serve.stop()

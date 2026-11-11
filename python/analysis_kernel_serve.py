"""``analysis_kernel.py serve``: starts the kernel, keeps it, and reports on it as one JSON event per line.

``ready`` (``kernel``, ``pid``), ``interrupted``, ``stopped``, ``dead`` (``message``) or ``missing`` (``message``),
each on stdout, flushed. ``SIGUSR1`` interrupts the kernel; ``SIGTERM``, ``SIGHUP`` or the parent process dying
(checked about once a second) shut it down (exit 0). Stdin is not watched: the server gives a child a closed stdin.
The kernel dying by itself exits 1; no ``ipykernel`` exits 2.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import signal
import subprocess
import threading
from pathlib import Path
from typing import Any

from analysis_kernel_preload import preload_code
from analysis_kernel_run import kernel_id, wait_reply

try:
    from jupyter_client import KernelManager
except ImportError:  # reported as `missing` before it is used
    KernelManager = None

MISSING_MESSAGE = "ipykernel is not installed in this Python. Assay's venv has it: open Settings and see the Doctor."
PARENT_CHECK_EVERY = 1.0
KERNEL_CHECK_EVERY = 0.1
KERNEL_READY_TIMEOUT = 60
PRELOAD_TIMEOUT = 120


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event), flush=True)


def is_installed() -> bool:
    return (
        importlib.util.find_spec("ipykernel") is not None
        and importlib.util.find_spec("jupyter_client") is not None
        and KernelManager is not None
    )


def stop_when_parent_dies(stop: threading.Event) -> None:
    parent = os.getppid()

    def watch_parent() -> None:
        while not stop.wait(PARENT_CHECK_EVERY):
            if os.getppid() != parent:
                stop.set()

    threading.Thread(target=watch_parent, daemon=True).start()


def run_preload(km: Any, analysis: Path) -> None:
    """Runs the preload in the kernel and raises when it fails."""
    kc = km.client()
    kc.start_channels()
    try:
        kc.wait_for_ready(timeout=KERNEL_READY_TIMEOUT)
        msg_id = kc.execute(preload_code(analysis), silent=True, store_history=False)
        reply = wait_reply(kc, msg_id, timeout=PRELOAD_TIMEOUT)
        if reply is None or reply["content"].get("status") != "ok":
            content = (reply or {}).get("content", {})
            failure = f"{content.get('ename', '')} {content.get('evalue', 'no reply')}"
            raise RuntimeError(f"preload failed: {failure}".strip())
    finally:
        kc.stop_channels()


def start(km: Any, analysis: Path) -> str | None:
    """Starts the kernel and runs the preload; the message for ``dead`` when that fails."""
    try:
        km.start_kernel(cwd=str(analysis), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run_preload(km, analysis)
    except Exception as exc:
        return f"The kernel did not start: {exc}"
    return None


def death_message(km: Any) -> str:
    code = km.provisioner.process.poll() if getattr(km, "provisioner", None) else None
    return "The kernel process exited" + (f" (code {code})." if code is not None else ".")


def keep(km: Any, stop: threading.Event, interrupt: threading.Event) -> str | None:
    """Interrupts the kernel when asked, until ``stop``; the message for ``dead`` when the kernel exits by itself."""
    while not stop.is_set():
        if interrupt.is_set():
            interrupt.clear()
            with contextlib.suppress(Exception):
                km.interrupt_kernel()
            emit({"event": "interrupted"})
        if not km.is_alive():
            return death_message(km)
        stop.wait(KERNEL_CHECK_EVERY)
    return None


def serve(analysis: Path, connection: Path) -> int:
    if not is_installed():
        emit({"event": "missing", "message": MISSING_MESSAGE})
        return 2

    stop = threading.Event()
    interrupt = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGHUP, lambda *_: stop.set())
    signal.signal(signal.SIGUSR1, lambda *_: interrupt.set())
    stop_when_parent_dies(stop)

    connection.parent.mkdir(parents=True, exist_ok=True)
    km = KernelManager(connection_file=str(connection))
    dead_message = start(km, analysis)
    if dead_message is None and not stop.is_set():
        emit({"event": "ready", "kernel": kernel_id(connection), "pid": os.getpid()})
        dead_message = keep(km, stop, interrupt)

    with contextlib.suppress(Exception):
        km.shutdown_kernel(now=True)
    if dead_message is not None:
        emit({"event": "dead", "message": dead_message})
        return 1
    emit({"event": "stopped"})
    return 0

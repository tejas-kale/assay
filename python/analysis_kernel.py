"""Assay's Python kernel: one long-lived kernel per session and a short client per run.

    python analysis_kernel.py serve --analysis <dir> --connection <file>
    python analysis_kernel.py run --connection <file> --analysis <dir> --code-file queries/NNN_x.py
                                  --timeout <s> --serve-pid <pid>

``serve`` starts an ipykernel (cwd ``<dir>``, connection file ``<file>``), runs the preload in it and prints one
JSON event per line on stdout, flushed: ``ready`` (``kernel``, ``pid``), ``interrupted``, ``stopped``, ``dead``
(``message``) or ``missing`` (``message``). ``SIGUSR1`` interrupts the kernel; ``SIGTERM``, ``SIGHUP`` or the
parent process dying (checked about once a second) shut it down (exit 0). Stdin is not watched: the server gives
a child a closed stdin. The kernel dying by itself exits 1; no ``ipykernel`` exits 2.

``run`` executes the code file's text in that kernel and writes ``queries/NNN_x.json`` (atomically, every 0.5 s
while running and once at the end) with ``NNN_x.tK.csv`` for each displayed table and ``NNN_x.pK.png|svg`` for
each plot, then prints one JSON summary line. It exits 0 whenever the run was carried out, whatever its status; 3
when the kernel could not be reached. Format of the files: ``docs/slice-3.md`` in the Assay repo.

This file lives in the Assay repo (``python/``); Assay's MCP server runs it by path (``$ASSAY_BACKEND/python``),
under the kernel python (a project ``.venv`` that has ipykernel, else Assay's venv, ``$ASSAY_VENV``). Only the
standard library, ``jupyter_client`` and ``ipykernel`` are imported (pandas, polars and matplotlib are used in the
kernel when the user's code has them).

The work is in three modules beside it: ``analysis_kernel_serve`` (the ``serve`` command),
``analysis_kernel_run`` (the ``run`` command) and ``analysis_kernel_preload`` (the code the kernel runs first).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from analysis_kernel_run import RunRequest, run_code_file
from analysis_kernel_serve import serve


def build_parser() -> argparse.ArgumentParser:
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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "serve":
        return serve(Path(args.analysis).resolve(), Path(args.connection))
    request = RunRequest(Path(args.connection), Path(args.analysis), args.code_file, args.timeout, args.serve_pid)
    return run_code_file(request)


if __name__ == "__main__":
    sys.exit(main())

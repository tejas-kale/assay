"""The preload: the Python the kernel runs once, in the user's namespace, before any run.

It defines ``q`` (a saved run's result as a DataFrame, recording which runs were read) and the formatter that turns
a pandas or polars frame into the table payload ``analysis_kernel_run.Run`` saves. It is a string because it runs
in the kernel, not here; ``preload_code`` fills in its three values.
"""

from __future__ import annotations

from pathlib import Path

TABLE_MIME = "application/vnd.assay.table+json"
MAX_ROWS = 100_000

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
        """The csv of step ``step`` (its number k or its name) of SQL run n, or None.

        The last step, ``final``, is the run's own.
        """
        prefix = glob.escape(os.path.join(queries, "%03d." % n))
        found = {}
        for path in sorted(glob.glob(prefix + "*.csv")):
            match = re.match(r"^(\d+)_(.+)\.csv$", os.path.basename(path)[len("%03d." % n):])
            if match:
                found[int(match.group(1))] = (match.group(2), path)
        try:
            steps_file = os.path.join(queries, "%03d.steps.json" % n)
            names = [each.get("name") for each in json.load(open(steps_file))["steps"]]
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
    return (
        PRELOAD.replace("__ANALYSIS__", repr(str(analysis)))
        .replace("__MIME__", repr(TABLE_MIME))
        .replace("__CAP__", str(MAX_ROWS))
    )

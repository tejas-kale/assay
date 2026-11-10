---
name: propose-trusted
description: Draft a trusted block, calculation (SQL template or Python function) or a data dictionary entry in the open analysis, with every file the Trust tab's Check needs. Use on your own when you are about to write the same cross-table logic a second time (a block), when a query you ran generalises into something reusable, or when a table has no dictionary entry. The user may call it with one argument - a run number, a catalog.schema.table, or a calculation name - and with none it uses the latest run.
---

# Propose a trusted block, calculation or dictionary entry

You only draft. The user presses Check and Trust in the Trust tab. Never run `analysis_trust`, never Check, Trust or
Reject a proposal, never write into the shared `trusted/` or `dictionaries/`.

If you started this on your own, say so in one line first: what you are drafting and why.

The open analysis's folder, `analyses/<slug>/` from the root, is named in the rules on each prompt. Drafts go in it:
`lib/trusted/` for calculations, `lib/dictionaries/` for dictionary entries.

## 1. Read the source

The argument decides:

- a number `N` is a run: load its code and a few result rows with `q(N)` through the `python` tool. Never run the
  query again;
- a dotted three-part name is a table, so a dictionary entry: call `discover-schema` for it, and read the runs in
  this analysis that touch it;
- a lower-case word is the name of an existing calculation, so change it: read its current files in the shared
  `trusted/` (`<root>/trusted/`) and start the draft from them;
- no argument: the latest run.

## 2. Pick the form and the name

- A table is a dictionary entry: a term on one table (a filter, a metric, a derived value).
- Cross-table logic you are about to write a second time is a **block**: one join or one grain, about 30 lines at
  most, with a contract (params -> grain -> columns). Prefer a block to a calculation: Claude's queries include
  blocks by name, while a calculation can only run whole.
- A query that answers one question is evidence, not trusted: propose it only when the user asks.
- Otherwise a run is a SQL template, unless it needed Python (loops, a library, several queries); then a Python
  function.
- Names are lower case, digits and `_`, starting with a letter.
- Refuse a name that already exists in the shared `trusted/`, unless the argument named it. Say so and ask for
  another name.
- Refuse a table without catalog and schema: tell the user to find them (`discover-schema`, or the run's
  `FROM`) and give `catalog.schema.table`.
- Refuse to overwrite a draft in `lib/` of the same name unless the user said to; offer a new name.

## 3. Write the files

Use the format reference below. Write with Write, into the draft folders.

- Generalise the literals of the run (dates, IDs, thresholds) into typed parameters, each used as `:name`.
- Fixture tables: a few real rows from the run's result, trimmed to the columns and rows a case needs. Replace
  identifying values (panelist IDs, emails, free text) with made-up ones.
- At least one case, plus one for an edge the run showed (an empty group, a null, a boundary date) if there was
  one.
- `live` takes the arguments of the run that inspired the draft.
- A block: the front matter's `block:` contract, `live` arguments that return a few thousand rows at most (the
  check compares every row), and the rebuild (below). Fixture cases are optional. Its SQL includes definitions by
  name where they fit (`{{ client_entry(s) }}`) and never another block.
- A dictionary entry: description, columns (name, type, description) and joins from `discover-schema` and the
  analysis's queries. Record a join on the table holding the foreign key. Add a definition only when a run in this
  analysis used it, and give each a case.

## 4. Self-check

Fix each before you reply:

1. every `:placeholder` is a declared parameter, and every parameter is used;
2. every parameter has a type (`string`, `integer`, `number`, `boolean`, `date`) and the SQL front matter a
   description;
3. every case's `args` name declared parameters;
4. `live` is present;
5. every definition has a case;
6. names are lower case;
7. a block: `block.columns` lists the SQL's output columns in order, `block.grain` matches the final `-- grain:`
   line, and `<name>.rebuild.sql` exists with its `-- rebuilt by:` line.

For a Python draft you may run its own tests with Bash from the analysis folder, with the python the rules'
test line names (Assay's venv, which has `analysis_trust`): `cd <analysis folder> && <python> -m pytest
lib/trusted/test_<name>.py`. Do not run anything else in Bash.

## 5. Reply

List the files written. End with one line: open the Trust tab and press Check on `<name>`.

## Format reference

Each example is valid as written. Replace names, tables and values.

### SQL template: `lib/trusted/<name>.sql` and `<name>.test.yaml`

Front matter in `/*--- ---*/` on top: `description` and `parameters`, as `name: type` or
`name: {type, default}` (a default makes it optional). SQL in Databricks dialect, parameters as `:name`.
A template with WITH or JOIN follows the `sql` tool's SQL rules, or Check fails at its `rules` step: a
`-- grain:` line above each CTE and the final SELECT, a `-- join:` line above each JOIN, CTEs named for what they
hold, no subquery in FROM or JOIN.

<!-- example: lib/trusted/completes_by_site.sql -->
```sql
/*---
description: Completes per site between two days.
parameters:
  start: date
  end: date
  status: {type: string, default: C}
---*/
SELECT site_id, count(*) AS completes
FROM main.panel.surveys
WHERE status = :status AND day BETWEEN :start AND :end
GROUP BY site_id
```

The fixture: `tables` (CSV text by full table name), `cases` (`args` and the expected result as CSV `expect`;
`ordered: true` when order counts) and `live` (the arguments of the live run).

<!-- example: lib/trusted/completes_by_site.test.yaml -->
```yaml
tables:
  main.panel.surveys: |
    id,site_id,status,day
    1,10,C,2026-01-02
    2,10,C,2026-01-03
    3,11,C,2026-01-03
    4,11,S,2026-01-03
    5,12,C,2026-02-01
cases:
  - args: {start: 2026-01-01, end: 2026-01-31, status: C}
    expect: |
      site_id,completes
      10,2
      11,1
live: {start: 2026-01-01, end: 2026-01-31, status: C}
```

### Block: `lib/trusted/<name>.sql`, `<name>.rebuild.sql` and `<name>.test.yaml`

A SQL template whose front matter has `block:`: `grain` (the output columns that identify one row, `[]` for one row)
and `columns` (every output column, in the SQL's order, with what it means). Check runs it live with the `live`
arguments, checks the grain, and compares every row with the rebuild's.

<!-- example: lib/trusted/site_surveys.sql -->
```sql
/*---
description: One row per survey between two days, with its site's name.
parameters:
  start: date
  end: date
block:
  grain: [survey_id]
  columns:
    survey_id: the survey
    site: the name of the site that ran it
    status: C when complete
---*/
-- grain: survey_id
SELECT s.id AS survey_id, t.name AS site, s.status
FROM main.panel.surveys s
-- join: many:1 on site_id
JOIN main.panel.sites t ON t.site_id = s.site_id
WHERE s.day BETWEEN :start AND :end
```

**The rebuild** is the same contract built independently, from the front matter alone: never show the rebuilder the
block's SQL. Ask Codex through the `delegate:codex` subagent; when Codex is unavailable, an Opus model in Copilot.
Give it the description, the parameters, the contract and the tables' dictionary entries, and ask for one Databricks
statement using the same `:name` parameters and returning the contract's columns. Save its answer as
`<name>.rebuild.sql` with a first line saying who wrote it: `-- rebuilt by: codex` or `-- rebuilt by: copilot-opus`.

<!-- example: lib/trusted/site_surveys.rebuild.sql -->
```sql
-- rebuilt by: codex
SELECT sv.id AS survey_id, st.name AS site, sv.status AS status
FROM main.panel.surveys sv, main.panel.sites st
WHERE st.site_id = sv.site_id AND sv.day >= :start AND sv.day <= :end
```

<!-- example: lib/trusted/site_surveys.test.yaml -->
```yaml
live: {start: 2026-01-01, end: 2026-01-31}
```

### Python function: `lib/trusted/<name>.py` and `test_<name>.py`

A function named after the file. First parameter the SQLAlchemy engine, then parameters annotated `str`, `int`,
`float`, `bool` or `date` (a default makes one optional). It has a docstring and returns a data frame. Its own
pytest file builds a DuckDB engine from CSV tables with `analysis_trust.fixture_engine`. A `<name>.test.yaml` as
above also works for Python.

<!-- example: lib/trusted/top_sites.py -->
```python
import pandas as pd
from sqlalchemy import text


def top_sites(engine, limit: int = 2):
    """The sites with the most completes, most first."""
    query = text("SELECT site_id, count(*) AS completes FROM panel.surveys GROUP BY site_id ORDER BY completes DESC, site_id LIMIT :limit")
    with engine.connect() as connection:
        return pd.read_sql(query, connection, params={"limit": limit})
```

<!-- example: lib/trusted/test_top_sites.py -->
```python
import analysis_trust
from top_sites import top_sites

TABLES = {"panel.surveys": "id,site_id\n1,10\n2,10\n3,11\n"}


def test_top_site_first():
    frame = top_sites(analysis_trust.fixture_engine(TABLES), limit=1)
    assert frame["site_id"].tolist() == [10]
```

### Dictionary entry: `lib/dictionaries/<catalog.schema.table>.yaml` and `.test.yaml`

`definitions` have a `name`, a `kind` (`metric`: an aggregate, grouped by `by`; `filter`: a row condition; `derived`:
a per-row value) and a Databricks SQL expression `sql` over the table. `joins` (a list of `{to: <table>, on: <condition>}`, not checked; omit if none) go on the
table holding the foreign key. The test file has `tables`, one case per definition (`definition`, optional `args` with
`by`, `filters`, `limit`) and `live`, a map from definition name to its live arguments.

<!-- example: lib/dictionaries/main.panel.surveys.yaml -->
```yaml
description: One row per survey.
columns:
  - {name: id, type: bigint, description: The survey.}
  - {name: site_id, type: bigint, description: The site.}
  - {name: status, type: string, description: C when complete.}
definitions:
  - name: completes
    kind: metric
    description: Surveys finished.
    sql: count_if(status = 'C')
```

<!-- example: lib/dictionaries/main.panel.surveys.test.yaml -->
```yaml
tables:
  main.panel.surveys: |
    id,site_id,status
    1,10,C
    2,10,S
    3,11,C
cases:
  - definition: completes
    args: {by: [site_id]}
    expect: |
      site_id,completes
      10,1
      11,1
live:
  completes: {by: [site_id]}
```

---
name: delegate
description: Run a delegated analysis from upfront grilling and preface approval through unattended SQL execution and defence-sheet generation. Use when the user asks to delegate a rollout check, parameter optimisation, or bounded analysis task.
---

# Delegate an analysis run

The open analysis's folder, `analyses/<slug>/` from the root, is named in the rules on each prompt;
every file below is in it.

1. If `analysis.yaml` is missing in `analyses/<slug>/`, tell the user to open the analysis in Assay and stop.

## 1. Grill up front and draft `preface.json`

Before writing any answer or reconciliation SQL, settle the task with the user:

1. Use `AskUserQuestion` (up to four questions per call) to settle:
   - the one metric the user will defend and its unit or scale;
   - the cohort, eligibility filters, and time windows (`YYYY-MM-DD` start and end dates);
   - the known total (`known_total`) and absolute `tolerance` from a backtest or baseline for a rollout check (for a parameter optimisation task, `known_total` may be omitted);
   - any foreseeable judgment calls (duplicate keys, null buckets, boundary timestamps), the default to take for each, and why.
2. Draft:
   - `low` and `high`: the expected range `[low, high]` for the single defended metric (`low <= high`);
   - `known_total` and `tolerance` (`tolerance >= 0`): required when `known_total` is set; omit `known_total` for an optimisation task that has no baseline total;
   - `falsifiers`: non-empty list of sentences the user will judge on the defence sheet (for an optimisation task, include the holdout window with `YYYY-MM-DD` dates that the tuning never touched);
   - `specs`: non-empty list of `{ "id": "<spec-id>", "text": "<prose spec>" }` entries covering the `answer` query and the `reconciliation` query (plus any supporting spec-gated queries);
   - `answer` and `reconciliation`: the spec ids in `specs` for the defended metric and the reconciliation check.
3. If neither a predicted `[low, high]` range nor falsifiers can be stated before seeing the result, tell the user in one line that this is an open understanding task rather than a delegable run, and stop.
4. Write `analyses/<slug>/preface.json` with `Write`:

```json
{
  "low": 0.12,
  "high": 0.18,
  "known_total": 1250,
  "tolerance": 5,
  "falsifiers": [
    "The rollout matches the backtest.",
    "Holdout window 2026-10-01 to 2026-10-14 does not regress."
  ],
  "answer": "rollout-rate",
  "reconciliation": "rollout-total",
  "specs": [
    {
      "id": "rollout-rate",
      "text": "Completion rate across eligible sessions between 2026-11-01 and 2026-11-08."
    },
    {
      "id": "rollout-total",
      "text": "Total eligible sessions between 2026-11-01 and 2026-11-08."
    }
  ]
}
```

## 2. Freeze the preface on the Overview tab

1. Ask the user to review or edit `analyses/<slug>/preface.json`, then press `f` on the Overview tab in Assay to freeze it into `analyses/<slug>/.assay/preface.json` (if a previous task's preface is still frozen, press `r` on the Overview tab to archive it into `.assay/preface-archive/<id>.json`, then press `f`).
2. Stop and wait for the user to confirm. Never write `.assay/preface.json` yourself, and never run answer or reconciliation SQL before `.assay/preface.json` is frozen.

## 3. Run unattended: exploration, spec-gated SQL, and decision log

Once the user confirms the preface is frozen:

1. Read `analyses/<slug>/.assay/preface.json` to verify it is frozen and load its `id`, `low`, `high`, `known_total`, `tolerance`, `falsifiers`, `answer`, `reconciliation`, and `specs`. If `.assay/preface.json` is missing, ask the user to press `f` on the Overview tab and stop.
2. **Exploration queries**: call `mcp__assay__sql` without a `spec` argument (`{ "sql": "...", "slug": "..." }`). Exploration runs stay ungated and do not trigger the per-step row-count pass.
3. **Answer and reconciliation queries**: call `mcp__assay__sql` with `spec` set to the approved spec `id` from `.assay/preface.json` (`{ "sql": "...", "slug": "...", "spec": "<spec-id>" }`):
   - Include approved trusted blocks (`{{ block(p => 'v') }}`) and dictionary definitions (`{{ definition(alias) }}`) wherever they fit instead of retyping their logic by hand.
   - The server records `-- preface: <id>`, `-- spec: <id>`, and `-- built from: ...` on the saved `.sql` file, updates `.assay/coverage.json`, and runs the per-step row-count pass (`queries/NNN.steps.json`) when the query finishes.
4. **Unattended judgment calls**: when an ambiguity arises mid-run that was not settled up front, do not stop. Take the sensible default, append one bullet to `analyses/<slug>/decisions.md`:
   `- **<decision>**: <default taken> — <why> ([q NNN])`
   and continue.

## 4. Write the defence sheet (`analyses/<slug>/defence-sheet.md`)

Read from the recorded files in `analyses/<slug>/` — always use the frozen `.assay/preface.json`, never the mutable draft `preface.json`:

1. Read `.assay/preface.json` and `.assay/coverage.json`.
2. List `queries/` and read every SQL run recorded under the frozen preface (`-- preface: <id>` and `-- spec: <spec-id>`):
   - `queries/NNN_<slug>.sql` (for `-- spec:`, `-- built from:`, and `YYYY-MM-DD` date arguments);
   - `queries/NNN_<slug>.csv` (the saved result);
   - `queries/NNN.steps.json` (the per-step row counts and grain/join checks);
   - `queries/NNN.notices.json` (when present, for stored `retype` warnings).
3. Read `decisions.md` when present.
4. Write `analyses/<slug>/defence-sheet.md` with these sections:
   - **Header & Status**: the frozen preface `id` and `frozenAt`, and a one-line status stating whether any of the four SQL review flags triggered.
   - **Review Flags**: the four flags in plain sight at the top (`OK` or `FLAG`), so the user opens SQL only when a flag triggers:
     - `Range`: latest run of the `answer` spec (`[q NNN]`) compared to `[low, high]` (`FLAG` when missing, `< low`, `> high`, or `(unfrozen)`).
     - `Reconciliation`: latest run of the `reconciliation` spec (`[q NNN]`) compared to `known_total ± tolerance` (`FLAG` when missing, `|actual - known_total| > tolerance`, or `(unfrozen)`; `OK` with `known_total omitted (optimisation task)` when `known_total` is omitted).
     - `Retype & Unfrozen Spec Warnings`: count of stored `retype` warnings from `queries/NNN.notices.json` plus any run whose spec was marked `(unfrozen)` (`FLAG` when `> 0`).
     - `Logged Decisions`: count of judgment calls logged in `decisions.md` (`FLAG` when `> 0`, so the user can check that every default is one they stand behind).
   - **Trusted-SQL Coverage**: the analysis's lexical token coverage share from `.assay/coverage.json` (`<pct>% (<trustedTokens> / <totalTokens> tokens)`).
   - **Specs, Runs & Step Counts**: one subsection per spec in `.assay/preface.json` (plus any `(unfrozen)` spec run):
     - approved spec prose `text`;
     - latest run `[q NNN]` and its actual value;
     - earlier runs `[q MMM]` with the same `spec` id (so reruns never hide an earlier attempt);
     - `Built from` pieces (`name@commit`) from the run's `-- built from:` header;
     - `Time windows` (`YYYY-MM-DD` date arguments in the saved query and in the spec text);
     - `Steps` from `queries/NNN.steps.json`: each step's name, block name (when a trusted block), row count, and any failed grain or join check.
   - **Stored Retype & Spec Warnings**: each stored `retype` warning (`qNNN: <warning>`) and any unfrozen spec warning, or `- None.`.
   - **Falsifiers**: every falsifier sentence from `.assay/preface.json` (including the holdout window for optimisation tasks) for the user to judge.
   - **Decision Log**: every logged decision (`- **<decision>**: <default taken> — <why> ([q NNN])`), or `- None.`.

## 5. Reply

Reply in at most two lines: name `analyses/<slug>/defence-sheet.md` and state which review flags (if any) triggered.

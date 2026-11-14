---
name: delegate
description: Run a delegated analysis from upfront grilling and preface approval through unattended SQL execution and defence-sheet generation. Use when the user asks to delegate a rollout check, parameter optimisation, or bounded analysis task.
---

# Delegate an analysis run

The open analysis's folder, `analyses/<slug>/` from the root, is named in the rules on each prompt;
every file below is in it unless noted otherwise.

1. If `analysis.yaml` is missing in `analyses/<slug>/`, tell the user to open the analysis in Assay and stop.

## 1. Grill up front and draft `preface.json`

Before writing any answer or reconciliation SQL, settle the task with the user:

1. Use `AskUserQuestion` (up to four questions per call) to settle:
   - the one metric the user will defend and its unit or scale;
   - the cohort, eligibility filters, and time windows (`YYYY-MM-DD` start and end dates);
   - the known total (`known_total`) and absolute `tolerance` from a backtest or baseline for a rollout check (for a parameter optimisation task, `known_total` and `reconciliation` may be omitted);
   - any foreseeable judgment calls (duplicate keys, null buckets, boundary timestamps), the default to take for each, and why.
2. Check delegability before looking at the data: **if neither a plausible `[low, high]` range nor at least two falsifiers can be written before looking, the task is an understanding task (not a delegated execution task) — tell the analyst in one line before starting and stop.**
3. Draft:
   - `low` and `high`: the plausible range `[low, high]` for the single defended metric (`low <= high`);
   - `known_total` and `tolerance` (`tolerance >= 0`, defaulting to `0` when omitted): required for a rollout check; omit `known_total` for an optimisation task that has no baseline total;
   - `falsifiers`: at least two concrete falsifier sentences the analyst will judge on the defence sheet (for an optimisation task, include the holdout window with `YYYY-MM-DD` dates that the tuning never touched);
   - `specs`: non-empty list of `{ "id": "<spec-id>", "text": "<prose spec>" }` entries (each `id` matching `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`) covering the `answer` query and, when present, the `reconciliation` query;
   - `answer` and `reconciliation`: the spec ids in `specs` for the defended metric and the reconciliation check (`reconciliation` may be omitted or `""` when `known_total` is omitted).
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

1. Read `analyses/<slug>/.assay/preface.json` to verify it is frozen and load its `id`, `frozenAt`, `low`, `high`, `known_total`, `tolerance`, `falsifiers`, `answer`, `reconciliation`, and `specs`. If `.assay/preface.json` is missing, ask the user to press `f` on the Overview tab and stop.
2. **Exploration queries**: call `mcp__assay__sql` without a `spec` argument (`{ "sql": "...", "slug": "..." }`). Exploration runs stay ungated and do not trigger the per-step row-count pass.
3. **Answer and reconciliation queries**: call `mcp__assay__sql` with `spec` set to the approved spec `id` from `.assay/preface.json` (`{ "sql": "...", "slug": "...", "spec": "<spec-id>" }`):
   - Include approved trusted blocks (`{{ block(p => 'v') }}`) and dictionary definitions (`{{ definition(alias) }}`) wherever they fit instead of retyping their logic by hand.
   - The server records `-- preface: <id>`, `-- spec: <id>`, and `-- built from: ...` on the saved `.sql` file, updates `.assay/coverage.json`, and runs the per-step row-count pass (`queries/NNN.steps.json`) when the query finishes.
4. **Unattended judgment calls**: when an ambiguity arises mid-run that was not settled up front, do not stop. Take the sensible default, log the decision in `analyses/<slug>/decisions.md` (and/or a root note labelled `decision`) with the default taken, why, and the run citation:
   `- **<decision>**: <default taken> — <why> ([q NNN])`
   and continue.

## 4. Write the defence sheet (`analyses/<slug>/defence-sheet.md`)

Compute and format the defence sheet directly from the recorded files in `analyses/<slug>/` — always read the frozen `.assay/preface.json`, never the mutable draft `preface.json`:

1. Read `.assay/preface.json` and `.assay/coverage.json`.
2. List `queries/` and read every SQL run recorded under the frozen preface (`-- preface: <id>` and `-- spec: <spec-id>`):
   - `queries/NNN_<slug>.sql` (for `-- spec:`, `-- built from:`, and `YYYY-MM-DD` date arguments);
   - `queries/NNN_<slug>.csv` (the saved result);
   - `queries/NNN.steps.json` (the per-step row counts and grain/join checks);
   - `queries/NNN.notices.json` (when present, for stored `retype` warnings).
3. Read `decisions.md` (and any decision notes in `notes/`).
4. Write `analyses/<slug>/defence-sheet.md` with these 7 sections in order:

   1. **Header**
      - `# Defence Sheet — <question or analysis title>`
      - `Preface: <id> (frozen <frozenAt>)`
      - One-line summary of the four SQL review triggers (missed plausible range, failed reconciliation, stored `retype` / `(unfrozen)` spec warnings, and logged decisions for the analyst to review).

   2. **Reconciliation**
      - Compare the latest run `[q NNN]` of the `reconciliation` spec against `known_total ± tolerance`:
        - `PASS` when `|actual - known_total| <= tolerance` (and the spec was frozen);
        - `FAIL` when missing, `(unfrozen)`, or `|actual - known_total| > tolerance`;
        - `N/A (no known_total)` when `known_total` was omitted for a parameter-optimisation task.
      - List any earlier runs `[q MMM]` for the `reconciliation` spec so reruns never hide an earlier attempt.

   3. **Plausible Range & Falsifiers**
      - **Plausible range**: compare the latest run `[q NNN]` of the `answer` spec against `[low, high]` (`PASS` when `low <= actual <= high` and the spec was frozen; `FAIL` when missing, `(unfrozen)`, `< low`, or `> high`), and list any earlier runs `[q MMM]` with the same `answer` spec id.
      - **Falsifiers**: list each falsifier sentence from `.assay/preface.json` with `PASS`, `FAIL`, or the evidence citation `[q NNN]` for the analyst to judge.

   4. **Spec & Step Counts**
      - For each spec in `.assay/preface.json` (plus any `(unfrozen)` spec run), show:
        - the approved spec `id` and prose `text`;
        - a Markdown table of the SQL run (`[q NNN]`), any earlier runs (`[q MMM]`), `Built from` trusted pieces (`name@commit` from `-- built from:`), `Time windows` (`YYYY-MM-DD` dates in the query and spec text), each step's name, block name, and row count from `queries/NNN.steps.json`, and `PASS`/`FAIL` for the step grain/join checks;
        - any stored `retype` warnings from `queries/NNN.notices.json` or `(unfrozen)` spec warnings (`PASS` when none, `FAIL` when any warning is present).

   5. **Trusted SQL Coverage**
      - Copy the figure from `.assay/coverage.json`: `<pct>% (<trustedTokens>/<totalTokens> lexical SQL tokens)` and `<trusted>/<total> SQL runs` across the analysis.

   6. **Logged Decisions**
      - List every logged decision from `decisions.md` and any root note with label `decision`, citing the run/note references (`[q NNN]`, `[[<ID>]]`) with the default taken and why for the analyst's judgment.
      - **Do NOT mark logged decisions as `FAIL` just because decisions exist** — logging unattended judgment calls is expected behaviour. Only flag `FAIL` if silent/unlogged scope or denominator choices were made without being recorded.

   7. **Holdout Check**
      - Evaluate the holdout slice named in `.assay/preface.json` (`PASS`/`FAIL` with the citing run `[q NNN]`, or `N/A` when the task has no holdout slice) and confirm tuning queries did not overlap the holdout window.

## 5. Reply

Reply in at most two lines: name `analyses/<slug>/defence-sheet.md` and state which review flags (if any) triggered.

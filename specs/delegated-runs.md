## Problem Statement

Handing off an analysis only pays if the result can be defended without reading every line of SQL. Today under a quarter of a typical analysis's SQL comes from trusted blocks and dictionary definitions. Assay records every run, expands includes, and warns when trusted logic is written out by hand, but it cannot vouch for fresh SQL, and it has nowhere to put a prediction that the agent cannot change after seeing the result.

The standard is defensibility: trust in the output, a basic grasp of what the query did, and the ability to answer scrutiny. The first proof is a rollout check reviewed from a defence sheet alone.

## Solution

Assay gains three things. A frozen preface holds the prediction, the known total, and the specs you approved, and the agent cannot revise it. Answer queries, named by a spec id, get the existing per-step row counts as they finish. The analysis shows what share of its SQL came from trusted blocks and dictionary definitions.

A workflow skill does the rest. It grills up front, drafts the preface for you to edit, asks you to approve specs before answer SQL is written, logs judgment calls, and writes the defence sheet from the preface and the runs. You read the sheet. You open SQL only when the range misses, the reconciliation misses, a retype warning is stored on a run, or a logged decision is one you would not stand behind.

## User Stories

1. As an analyst, I want the agent to draft an expected range and the falsifiers before a delegated run, so that I can edit them while I still do not know the result.
2. As an analyst, I want to approve the text of each answer query's spec before that SQL is written, so that exploration can stay open and the answer cannot be invented unsupervised.
3. As an analyst, I want one key on the Overview tab to freeze the draft preface, so that my approval is the copy that later review uses.
4. As an analyst, I want the frozen preface to be impossible for the agent to edit, so that the range and the known total cannot be fitted to the result afterwards.
5. As an analyst, I want a second accept refused until I reset, so that a frozen preface is not casually replaced.
6. As an analyst, I want reset to archive the frozen preface, so that the range for the task I already ran is still there after the next task starts.
7. As an analyst, I want each run to record which preface was current, so that a result stays attached to the prediction it was made under.
8. As an analyst, I want the preface to name the answer spec and the reconciliation spec, so that the sheet compares those runs and not a more convenient one.
9. As an analyst, I want `low` and `high` for the one metric I will defend, so that the range flag is a single comparison.
10. As an analyst, I want a frozen `known_total` and an absolute `tolerance` for a rollout check, so that reconciliation is against the backtest figure I wrote down.
11. As an analyst, I want an optimisation task to be allowed to leave `known_total` empty, so that the first build does not invent a total for that task type.
12. As an analyst, I want falsifiers stored as sentences, including the holdout window when the task is an optimisation, so that I can judge them on the sheet.
13. As an analyst, I want each spec stored as an id plus the text I approved, so that Assay does not pretend to prove the SQL matches the prose.
14. As the agent, I want to pass a spec id when I run answer SQL, so that the run is tied to a spec I claim to be executing.
15. As an analyst, I want a run with no spec id treated as exploration, so that exploration does not pay for step counts.
16. As an analyst, I want a spec id that is in the frozen preface to trigger the existing step-count pass when the query finishes, so that the sheet has row counts when I come back.
17. As an analyst, I want a spec id that was not frozen to still run, with the step counts, and to be marked as not in the preface, so that a missed approval is visible and the query is not blocked.
18. As an analyst, I want the latest run of the answer spec compared to `low` and `high`, so that a miss sends me to the SQL.
19. As an analyst, I want the latest run of the reconciliation spec compared to `known_total` within `tolerance`, so that a failed reconciliation sends me to the SQL.
20. As an analyst, I want earlier runs with the same spec id listed on the sheet, so that a rerun does not hide the first attempt.
21. As an analyst, I want the sheet to show the definitions a run was built from, so that I can see which came from trusted blocks and dictionary definitions.
22. As an analyst, I want the sheet to show time windows as the date arguments in the saved queries and in the spec text, so that the dates are in plain sight.
23. As an analyst, I want retype warnings already stored on those runs listed on the sheet, so that hand-written trusted logic sends me to the SQL.
24. As an analyst, I want every logged decision on the sheet with the default taken and why, so that I can open the SQL when a decision is one I would not stand behind.
25. As an analyst, I want the falsifiers printed for me to judge, so that a holdout is part of the review even though Assay does not evaluate the sentence.
26. As an analyst, I want the analysis's trusted-SQL coverage on the Overview header and copied onto the sheet, so that I can see whether the audit raised the share.
27. As an analyst, I want coverage to be the trusted share of every SQL run in the analysis, so that the before and after of the audit are the same measure.
28. As an analyst, I want a run made with the trusted tool to count as fully trusted, and Python to be excluded, so that the figure describes SQL.
29. As an analyst, I want to do the one-off audit with today's Trust tab Check and independent rebuild, so that buyer-quality rules, window blocks, and outcome metrics become trusted pieces without a new audit workflow.

## Implementation Decisions

- The agent writes a draft `preface.json` in the analysis. The Overview key freezes a copy under `.assay/`. That copy is agent-immutable in the same way as the analysis's other server-owned files. One preface is current. Reset archives it and allows a new draft. Each run records the identity of the preface that was current.
- The frozen preface has this shape. `known_total` may be omitted.

```json
{
  "low": 0.0,
  "high": 0.0,
  "known_total": 0.0,
  "tolerance": 0.0,
  "falsifiers": ["The rollout matches the backtest."],
  "answer": "rollout-rate",
  "reconciliation": "rollout-total",
  "specs": [
    { "id": "rollout-rate", "text": "The spec you approved, in prose." }
  ]
}
```

- `tolerance` is an absolute amount. `answer` and `reconciliation` are spec ids present in `specs`.
- The SQL tool takes an optional spec id. The server stores it on the run. If the id is in the current frozen preface, the server runs the same step-count pass the Steps tab uses when the query finishes. If the id is absent, it does not. If the id is not in the preface, the query still runs, the pass still runs, and the run records that the spec was not frozen. A failed count pass leaves the run recorded and the counts missing.
- Assay does not refuse a run for a missing spec, a missed range, or a failed reconciliation. It does not compare a query to its spec text, and it does not parse falsifiers.
- Coverage is the sum, across every SQL run in the analysis, of lexical tokens that came from approved block bodies and definition expansions, divided by the sum of lexical tokens in the expanded SQL, comments and whitespace aside. A trusted-tool run counts as fully trusted. Python runs are excluded. The server writes the figure. The Overview header shows it.
- The workflow skill writes the defence sheet. It copies the frozen preface, the coverage figure, the built-from list, the stored retype warnings, and the step counts. It compares the latest answer run to `low` and `high`, and the latest reconciliation run to `known_total` within `tolerance`. It lists earlier runs with the same id, the falsifiers, the windows, and the decision log. Where the skill's files live was not decided.

## Testing Decisions

Test external behaviour at the seams that already exist: accepting and resetting a preface, running SQL, and the step-count pass.

- A good test drives those actions and reads the preface that was frozen, the preface identity and spec id on the run, whether step counts were produced, and the coverage figure. It does not assert private helpers.
- Cover a frozen preface the agent cannot overwrite, a second accept refused until reset, an archive that remains after reset, a run that names the preface that was current, an answer spec that gains step counts, exploration that does not, an unknown spec id that still runs and is marked not frozen, a trusted-tool run counted as fully trusted, a partial include counted by its expanded tokens, and Python excluded.
- Prior art is the tests that already drive a SQL run, an include, a retype warning, and the step-count pass, and the tests that accept a file from the app and then read it back.

## Out of Scope

- Rendering the defence sheet in the app, a new tab, a spec-contract checker, a holdout-overlap check, a decision-log tool, and refusing runs.
- Classifying which logged decision changed the answer. The sheet lists them. You decide which ones you would not stand behind.
- The one-off audit as a product workflow. It stays a work session on the Trust tab. Buyer quality and suppression, pre and post windows as block parameters, and outcome metrics are the examples that should move the coverage number.
- Building the parameter-optimisation known total. The spec stores the holdout as a falsifier sentence and may omit `known_total`.
- Daily priorities and the block of time without Claude.
- Tickets. Not split in this session.

## Further Notes

Rollout checks are the first build. The workflow has worked when, after that build, a rollout check can be reviewed from the defence sheet alone and defended when questioned.

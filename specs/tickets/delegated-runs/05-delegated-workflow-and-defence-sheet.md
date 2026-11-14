# 05: Delegated analysis workflow skill and defence sheet writer

**What to build:** a workflow skill in `plugin/skills/` that runs the delegated analysis handoff loop — grilling up
front, drafting `preface.json` for the analyst to edit and freeze on the Overview tab, gating answer and reconciliation
SQL on approved specs, logging judgment calls during unattended execution, and writing the defence sheet from the frozen
preface and recorded runs. Spec:
https://github.com/tejas-kale/assay/issues/9#issuecomment-6879918940.

**Blocked by:** 03 (Run automatic step counts on `sql` calls with a spec id), 04 (Compute trusted-SQL lexical token coverage and show it on the Overview header).

**Status:** ready-for-agent

- [ ] Up front, the skill grills the analyst to settle the work, drafts `preface.json` with `low`, `high`, `known_total` (optional for optimisation tasks), `tolerance`, `falsifiers` (including holdout window sentences), and approved `specs` (`answer` and `reconciliation`), and waits for the analyst to freeze the preface on the Overview tab before running answer queries.
- [ ] Every query that feeds the answer or reconciliation runs with its approved `spec` id; pure exploration runs without a `spec` id; on an unattended judgment call the agent takes the default, logs the decision with the default taken and why, and continues.
- [ ] The defence sheet copies the frozen preface, the analysis's trusted-SQL coverage figure, the built-from trusted definitions/blocks list, the time windows (date arguments in saved queries and spec text), and the per-step row counts.
- [ ] The defence sheet compares the latest `answer` spec run against `[low, high]` and the latest `reconciliation` spec run against `known_total ± tolerance`, and lists any earlier runs with the same spec ids so reruns do not hide earlier attempts.
- [ ] The defence sheet surfaces all four SQL review flags in plain sight: missed range, failed reconciliation, stored retype warnings on the runs, and the logged decisions with their defaults and reasons, plus the falsifier sentences for the analyst to judge.

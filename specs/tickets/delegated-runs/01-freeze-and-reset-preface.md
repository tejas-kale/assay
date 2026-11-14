# 01: Freeze and reset the preface from the Overview tab

**What to build:** the analyst can freeze a draft `preface.json` in the analysis folder from the Overview tab into an
agent-immutable copy under `.assay/`, see whether a preface is frozen on the Overview tab, and reset the frozen preface
(archiving it under `.assay/`) when starting a new delegated task. Spec:
https://github.com/tejas-kale/assay/issues/9#issuecomment-6879918940.

**Blocked by:** None (can start immediately).

**Status:** done

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
    { "id": "rollout-rate", "text": "The spec you approved, in prose." },
    { "id": "rollout-total", "text": "The reconciliation spec you approved, in prose." }
  ]
}
```

- [x] A draft `preface.json` in the analysis folder is validated against the preface schema (`low`, `high`, optional `known_total` and `tolerance`, `falsifiers` as sentences, `specs` as `{ id, text }[]`, `answer` and `reconciliation` naming ids present in `specs`).
- [x] Pressing the freeze key on the Overview tab freezes a validated copy under `.assay/` with a stable preface identity and shows the frozen state on the Overview tab.
- [x] The frozen preface under `.assay/` cannot be written or edited by the agent's file tools.
- [x] A second freeze is refused while a preface is already frozen, until the analyst resets.
- [x] Resetting from the Overview tab archives the current frozen preface under `.assay/` so its prediction and specs remain preserved on disk, and allows freezing a new draft.

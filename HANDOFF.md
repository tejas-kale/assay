# Handoff: guided Assay workflow trial

## Resume here

The user wants to trial a decision-oriented analytical workflow manually before implementing Assay changes. Continue the design interview, one question at a time.

The last question is unanswered:

> What actual analytical task will you use for the first trial? Describe it as: “I need to determine ___ so that I can ___.”

Recommend an upcoming real task with a concrete decision or deliverable. Wait for the answer before designing task-specific guidance.

## Read next

- `docs/decision-workflow-trial.md`: saved rationale, proposed trial, candidate enhancements and the separate multiple-analysis request. This is discussion material, not an approved implementation specification.
- `.threads/2026-11-09-brain-fry-assay.md`: current session agenda; two topics remain open. This ignored file may not travel with the repository, so both topics are captured below.
- `/home/node/.agents/skills/grilling/SKILL.md`: the user explicitly invoked `$grill-me`, whose supplied wrapper delegates to `grilling`. Continue that interview. The user's one-question-at-a-time instruction takes precedence over the skill's multi-question rounds.

## Open topics, in order

1. **Guided manual trial.** The user fears falling back into existing habits and ending with no meaningful comparison. They want an explicitly invoked skill or mode in the Claude Code session inside Assay: state an outcome, receive guidance through one or more bounded steps. Decide the first task, baseline, guidance intensity, stopping rules, evidence capture and success criteria. The exact mechanism and protocol remain undecided.
2. **Multiple analyses in one window.** The user requests a floating bottom pane showing running analyses and Cmd+1, Cmd+2, Cmd+3 switching. Clarify open versus concurrently executing analyses, state preservation and how switching interacts with attention management. This request is parked while the trial is designed.

## Settled direction and limits

The user accepted the recommendation to trial manually before implementing anything here. The discussion favoured enhancing Assay incrementally rather than replacing it. A five-workday trial and measures of resumption time and retained understanding were suggestions, not a final agreed protocol.

The article's useful pattern is durable work items, bounded agent work, one human decision at a time, and a saved verdict/next action before switching. Analytical evidence and uncertainty must remain inspectable; successful execution alone does not establish a valid conclusion.

Assay already has file-backed threads, recorded runs and evidence-linked notes. Preserve its invariant that all analytical execution goes through the recorded execution path. See `README.md` for architecture; `src/core/threads.ts` currently represents open threads as strings and closed threads with optional outcomes.

## Work completed

Read https://sergeykuhne.com/blog/fighting-ai-brain-fry and inspected the README, thread model, and resume/wrap-up skills. Saved the discussion in `docs/decision-workflow-trial.md` and tracked topics in `.threads/`.

No app code or trial skill has been implemented. No tests were needed for these documentation-only changes. No commits were made in this session. At handoff creation, the proposal document was untracked; preserve it along with this handoff when transferring sessions.

## Interview behaviour

Keep responses concise and concrete, ask one question at a time, and give a recommendation with each design question. Investigate repository facts rather than asking the user to supply them. Resolve the trial design before treating it as authority to implement a skill or app mode; the grilling skill calls for shared-understanding confirmation before acting on the design.

# Decision workflow: manual trial and possible enhancements

Status: trial abandoned on 2026-11-09; kept as discussion notes only. Not an implementation specification.

Source: [Sergey Kuhne, How I'm fighting the AI Brain Fry](https://sergeykuhne.com/blog/fighting-ai-brain-fry).

## Purpose

Reduce context reconstruction and unfinished mental work while preserving understanding of analytical conclusions. Keep questions, evidence, decisions and next actions outside the chat transcript.

Assay already supplies file-backed threads, recorded SQL/Python runs, evidence-linked notes and human review of trusted calculations. Extend these foundations if the trial demonstrates value; replacement is not currently justified.

## Proposed manual trial

Suggested duration: five workdays; not yet agreed as a final protocol.

1. Pick one analytical question and define what would count as answered.
2. Give Claude a bounded investigation and an explicit stopping point. Park additional questions.
3. Review a brief containing the finding, supporting runs, assumptions, uncertainty and one decision needed from the user.
4. Before accepting the finding, explain in the user's own words what the evidence establishes and what it does not. Claude checks that explanation against the evidence.
5. Save the verdict, reasoning and next action before switching. Keep unfinished work open with its blocker or next step; returning it to the queue is not completion.

Suggested observations: time required to resume a question, and ability to explain yesterday's conclusion before reopening notes. Establish a baseline and success criteria during trial design.

## Requested guidance mechanism

The user wants an explicitly invoked skill or mode in the Claude Code session inside Assay. They state an outcome; Claude guides them through one or more bounded steps under the trial framework. The purpose is to prevent habitual chat-driven work from invalidating the comparison.

This mechanism is being designed through an interview. No skill or app mode has been implemented. Open decisions include the first real task, baseline, degree of guidance, stopping rules, evidence capture and criteria for keeping or abandoning the workflow.

## Candidate enhancements after the trial

- Structured thread states: ready for agent, working, needs user decision, blocked and done; capture next action and blocker.
- A prioritised decision inbox, initially within an analysis, with evidence links.
- A focused review brief and a saved human verdict with rationale.
- Cross-analysis aggregation if the trial demonstrates a need.

Defer autonomous scheduling and parallel investigations until review load and workflow value are understood. All analytical execution must continue through Assay's recorded execution path. Passing tests does not establish analytical validity.

## Separate requested enhancement: multiple analyses in one window

The user proposes a floating pane at the bottom listing running analyses, with Cmd+1, Cmd+2 and Cmd+3 switching between them.

This is a request for exploration, not an approved implementation design. Clarify whether analyses merely stay open or actually execute concurrently, what state survives switching, shortcut conflicts, and how the interface avoids encouraging the context switching the trial aims to reduce. Discuss after the guided-trial design.

## Next discussion

Choose a concrete analytical task for the guided trial before designing the guidance mechanism around it.

---
name: wrap-up
description: Close out an analysis session so the next one can resume. Use when the user says they are stopping, wrapping up, or done for now.
---

# Wrap up an analysis session

The open analysis's folder, `analyses/<slug>/` from the root, is named in the rules on each prompt;
`threads.md`, `analysis.yaml` and `queries/` below are in it; root notes are in `notes/` at the root.
Never Write or Edit under `notes/`: use the note tools.

1. Read `threads.md`. For each open thread this conversation answered, call
   `mcp__assay__close` with the thread's number and a one-line outcome. For each fork that came
   up and is not in `threads.md`, call `mcp__assay__park` with it as a one-line question.
2. Read the notes `analysis.yaml` lists under `notes.written`. List each verified finding (a query or
   trusted run in this conversation showed it) that no note holds yet, one line each with its run. Where a
   finding extends a written note, offer `mcp__assay__revise_note` on that note instead of a new one. Ask the user which to keep (one
   AskUserQuestion), then write each kept finding with `mcp__assay__note` (a title and text citing its
   run as `[<slug> q N]`; the server derives the label, never write one).
3. Call `mcp__assay__note_labels` with `{ weak: true }`. For each note with an unverified, stale or
   missing citation, ask verify, keep or delete with AskUserQuestion, at most four notes per question; offer
   delete only for notes this analysis wrote. Then act:
   - verify: run a query that backs the number (for a stale citation, rerun the calculation with
     `mcp__assay__trusted`), then call `mcp__assay__revise_note` to cite the new run;
   - keep: change nothing;
   - delete: call `mcp__assay__revise_note` with `delete: true`.
4. Call `mcp__assay__link_notes` with the IDs of root notes you Read this session that
   `analysis.yaml` does not list under `notes.written` or `notes.found`.
5. Reply with one line: the open thread count, the next open thread, and the notes written this session.
   Export nothing and make no slides.

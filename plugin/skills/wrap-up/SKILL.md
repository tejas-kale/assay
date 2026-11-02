---
name: wrap-up
description: Close out an analysis session so the next one can resume. Use when the user says they are stopping, wrapping up, or done for now.
---

# Wrap up an analysis session

1. Read `threads.md`. For each open thread this conversation answered, call
   `mcp__plugin_assay_assay__close` with the thread's number and a one-line outcome.
2. For each fork that came up in this conversation and is not in `threads.md`, call
   `mcp__plugin_assay_assay__park` with it as a one-line question.
3. Read `notes.md`. List each fact a query in this conversation verified that is not noted
   yet, one line each with its query number. Ask the user which to keep. Do not write any
   yet.
4. For each one the user approves, call `mcp__plugin_assay_assay__note` with the line and its
   `query` number. The server labels it; never write a label, and never edit `notes.md` directly.
5. List every note in `notes.md` labelled `[unverified]` or `[unverified q NNN]`, with its
   line number. For each, ask the user (`AskUserQuestion`, up to 4 notes per call): verify
   now with a query, keep as unverified, or delete. To verify, run the query with
   `mcp__plugin_assay_assay__sql` and call `mcp__plugin_assay_assay__revise_note` with the note's line number
   and the new `query`; to delete, call it with `delete: true`. Keeping needs no call.
6. Write the session into the analysis's denote note in `~/Code/notes/claude/`, following
   that repo's `AGENTS.md`. `<path>` is the analysis folder relative to `~/Code/notes-src`:
   `analyses/<folder>`, or `investigations/<folder>` or `explorations/<folder>` for older
   ones. The note's tags are `analysis` and the folder name with everything but letters
   and digits removed, so `quarantine-high-anchor` gives `__analysis_quarantinehighanchor`.
   If a `claude/*__analysis_<tag>.md` exists, update it. Else, if an older
   `claude/*__investigation_<tag>.md` exists, update that one and change its `investigation`
   tag to `analysis` in its file name and front matter. Otherwise create
   `<ID>--<folder>__analysis_<tag>.md` with the ID from `date +%Y%m%dT%H%M%S`. The note
   holds:
   - a claim-first summary of what is settled;
   - `## Findings`: each line of `notes.md`, its query number linked to
     `https://github.com/tejaskale-cint/notes-src/blob/main/<path>/queries/<file>.sql`;
   - `## Open threads`: the lines under `## Open` in `threads.md`.
7. Run `wiki-check` in `~/Code/notes` and fix the note until it exits 0. Do not commit in
   either repo.
8. Reply with one line: the open thread count, the next open thread, and the note's path.
   Do not export the notebook or make slides.

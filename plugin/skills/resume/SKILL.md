---
name: resume
description: Pick up an analysis where the last session stopped. Use at the start of a session in Assay, where Claude works from the root and one analysis is open (one with an analysis.yaml file).
---

# Resume an analysis

The open analysis's folder, `analyses/<slug>/` from the root, is named in the rules on each prompt;
every file below is in it. Run no code and no queries.

1. If `analysis.yaml` is missing in that folder, tell the user to open the analysis in Assay and stop.
2. Read `analysis.yaml` (title, `notes.written`, `notes.found`) and `threads.md`. For the IDs under
   `notes.written` and `notes.found`, read the first line (the title) of each root note
   (`<root>/notes/<ID>-*.md`); do not read their bodies. List `queries/` and read the `.sql` and `.py` files
   of the five highest-numbered runs. Do not read the `.csv` or `.json` files.
3. If the analysis has no runs, no notes and no threads, say so in one line, ask what to look at, and stop.
4. Reply in at most five lines:
   - the analysis title;
   - the notes: how many this analysis wrote (the titles of the latest few) and how many it found;
   - the open threads: the count and the first under `## Open`, or that none is open;
   - the latest run: its number and what it did.
5. If `notes.found` is empty and the analysis has runs, look for past notes to link:
   - Grep the root's `notes/` for the tables the runs read and for their distinctive terms (a column, a
     metric, a filter value);
   - if nothing matches, say so in one line and go to step 6;
   - otherwise offer up to five notes by title, newest first, with one AskUserQuestion (multi-select), and
     call `mcp__assay__link_notes` with the IDs of the ones chosen. Call nothing if none is chosen.
6. Ask which thread to take up, then wait for the answer.

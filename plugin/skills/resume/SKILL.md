---
name: resume
description: Pick up an analysis where the last session stopped. Use at the start of a session in Assay, where Claude works from the root and one analysis is open (one with an analysis.yaml file).
---

# Resume an analysis

The open analysis's folder, `analyses/<slug>/` from the root, is named in the rules on each prompt;
every file below is in it.

1. If `analysis.yaml` is missing in that folder, tell the user to open the analysis in
   Assay and stop.
2. Read `notes.md` and `threads.md`. List `notes/` and read the first line (the title) of each
   note file there; do not read their bodies. List `queries/` and read the `.sql` and `.py` files
   of the five highest-numbered runs. Do not read the `.csv` or `.json` files.
3. Reply in at most five lines:
   - what is established (from the notes, and how many note files there are, with the titles of
     the latest few),
   - the open threads: the count and the first under `## Open`, or that none is open,
   - the runs: how many there are, and what the latest did.
4. Ask which thread to take up, then wait for the answer. Run no code and no queries.

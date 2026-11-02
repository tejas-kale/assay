# Slice 8 spec: trust drafting and skills for root notes (slice 4 of 4)

Status: `ready-for-agent`.

Slice 4 of the four agreed on 2026-11-02 (see `slice-5.md`, "The four slices"). The first draft came from a grilling
session on 2026-11-02 and was revised on 2026-11-02 after slice 7 shipped. It builds on slice 7 (root notes) and on
slice 5, which already shipped the Trust tab's Check / Trust / Reject buttons.

## What slice 7 already did, and what is left

- **Already done in slice 7:**
  - The server has `note`, `revise_note` and `link_notes`, and refuses Write and Edit under `notes/`.
  - The first run of an analysis with no notes ends with a line telling Claude to search `notes/` and call
    `link_notes`, once per session.
  - The resume skill reads the titles of the notes under `notes.written` and `notes.found` and counts them.
  - Steps 3 to 5 of wrap-up already write notes with `note` and change them with `revise_note`.
- **Left for this slice:**
  - Wrap-up still writes a denote note in `~/Code/notes/claude/` and runs `wiki-check`.
  - Resume does not offer past notes to link.
  - Nothing helps with unverified citations.
  - The per-prompt rules still carry the full trusted-calculation drafting paragraph, and drafts fail Check for
    reasons the draft could have avoided.
  - The README still names facts and the denote note in places.

## Problem Statement

Proposing a trusted calculation or a dictionary entry is a long rule repeated on every prompt, and Claude drafts them
inconsistently. Placeholders don't match the declared parameters, fixture cases are missing, `live` arguments are
missing, and definitions are untested. So the Trust tab's Check fails for reasons the draft could have avoided, and
the analyst fixes files by hand.

At the end of a session, wrap-up still exports a summary to a separate wiki that root notes have replaced. It also
leaves weak evidence alone: a root note citing an unverified run looks the same in Claude's view as one citing a
trusted run, because no tool tells Claude a citation's label. At the start of a session, resume on an older
analysis never offers the past findings that slice 7 made searchable.

## Solution

- **`assay:propose-trusted`, a new skill:**
  - It drafts a trusted calculation (SQL template or Python function) or a dictionary entry in the open analysis's
    drafts, with every file the Trust tab's Check needs.
  - It checks its own form, then tells the analyst to press Check in the Trust tab.
  - Claude starts it on its own when a query generalises or a table has no dictionary entry. The analyst can start
    it with a run number, a calculation name or a table.
  - The per-prompt rules shrink to one line pointing at it.
- **Resume, rewritten for root notes:**
  - It reports what the analysis wrote and found.
  - On an analysis with no found notes, it offers up to five relevant root notes to link.
- **Wrap-up, rewritten:**
  - It closes and parks threads as before.
  - It writes new findings as root notes.
  - It walks through the analysis's weakly backed citations (unverified, stale, missing), asking verify / keep /
    delete for each.
  - It links the notes Claude read this session.
  - It writes no denote note and runs no `wiki-check`.
- **`note_labels`, one new read-only server tool:** it gives Claude the label of each citation in the notes this
  analysis wrote, so wrap-up can find the weak ones.

## User Stories

### Drafting trusted calculations and dictionary entries

1. As an analyst, I want Claude to draft a trusted calculation from a query I keep reusing, so that the next analysis runs it with `trusted` instead of writing new SQL.
2. As an analyst, I want to type `/assay:propose-trusted 12` to draft one from run 12, so that I choose what becomes trusted.
3. As an analyst, I want `/assay:propose-trusted churn_rate` to change the trusted calculation of that name, so that I can improve one that exists.
4. As an analyst, I want `/assay:propose-trusted main.panel.surveys` to draft that table's dictionary entry, so that I can fill a gap I noticed.
5. As an analyst, I want Claude to start the skill on its own when a table has no dictionary entry or a query clearly generalises, so that drafts appear without my asking.
6. As an analyst, I want Claude to tell me in one line when it starts the skill on its own, so that a draft never appears silently.
7. As an analyst, I want the draft to be a SQL template unless the run needed Python, so that each calculation takes the simplest form that works.
8. As an analyst, I want a SQL template drafted with front matter (description, typed parameters) and `:param` placeholders that match the parameters exactly, so that the form check passes.
9. As an analyst, I want a Python function drafted with a docstring, the engine first and typed parameters, returning a data frame, so that the form check passes.
10. As an analyst, I want the draft's parameters generalised from the literals in the run (dates, IDs, thresholds), so that the calculation is reusable and not a copy of one query.
11. As an analyst, I want every parameter given a type and a description, so that the trusted list shows how to call it.
12. As an analyst, I want a fixture file with small tables, at least one case and `live` arguments, so that Check runs tests and a live run.
13. As an analyst, I want fixture tables built from a few real rows of the run's result, trimmed to the columns and rows the case needs, so that cases are realistic but small.
14. As an analyst, I want identifying values in fixture rows (panelist IDs, emails, free text) replaced with made-up ones, so that no personal data reaches the shared trusted folder.
15. As an analyst, I want the `live` arguments taken from the run that inspired the draft, so that the live check reruns something I already saw.
16. As an analyst, I want a case that covers an edge the run showed (an empty group, a null, a boundary date) when there is one, so that the tests check more than the happy path.
17. As an analyst, I want a dictionary draft with a description, columns (name, type, description) and joins from `discover-schema` and the analysis's queries, so that the entry's form check passes.
18. As an analyst, I want joins recorded on the table holding the foreign key, so that the dictionary follows its own convention.
19. As an analyst, I want definitions in a dictionary draft only when a run in this analysis used them, each with a fixture case, so that every definition is tested.
20. As an analyst, I want the skill to refuse a table named without catalog and schema, and say how to find them, so that the entry's file name is right.
21. As an analyst, I want the draft to check its own placeholders, parameters, cases and names before it finishes, so that obvious form errors are fixed before I press Check.
22. As an analyst, I want the skill to run the pytest tests of a drafted Python calculation from the analysis folder, so that the function's own tests pass before Check.
23. As an analyst, I want the skill to end by naming the files it wrote and telling me to press Check on the proposal in the Trust tab, so that I know the next step.
24. As an analyst, I want Claude never to Check, Trust or Reject a proposal, so that promotion stays mine.
25. As an analyst, I want the skill to refuse a name that already exists in the shared `trusted/`, unless I asked to change that calculation, so that drafts do not shadow trusted ones by accident.
26. As an analyst, I want a draft that changes an existing trusted calculation to start from its current files, so that the change is a small diff I can review.
27. As an analyst, I want the skill to refuse to overwrite a draft already in the analysis with the same name unless I say so, so that my edits to a draft are not lost.
28. As an analyst, I want the per-prompt rules to point at the skill instead of repeating the drafting rules, so that every prompt carries less text.
29. As an analyst, I want the server's "no dictionary entry" reply to name the skill, so that Claude drafts the entry the same way every time.

### Resume

30. As an analyst, I want `/assay:resume` to read `analysis.yaml`, the threads and the five latest runs, so that it fits the root layout.
31. As an analyst, I want resume to report the analysis title, its written notes (count and latest titles), its found notes (count), the open threads and the latest run, in at most five lines, so that I can pick up quickly.
32. As an analyst, I want resume, on an analysis with runs and no found notes, to search the root notes for the tables and topics of its runs and offer up to five by title, so that an older analysis also benefits from past findings.
33. As an analyst, I want to pick which offered notes to link, and have Claude call `link_notes` with only those, so that `notes.found` holds what I chose.
34. As an analyst, I want resume to skip the offer when the search finds nothing, and say so in one line, so that it does not invent relevance.
35. As an analyst, I want resume to ask which thread to take up and run no code or queries, so that it stays a read-only start.
36. As an analyst, I want resume on a new analysis (no runs, no notes, no threads) to say so in one line and ask what to look at, so that it does not fail on an empty folder.

### Wrap-up

37. As an analyst, I want `/assay:wrap-up` to close the threads this session answered and park new forks, so that `threads.md` is current.
38. As an analyst, I want wrap-up to list the findings this session showed that no note holds yet, each with its run, and write the ones I keep with `note`, so that findings reach the root notes.
39. As an analyst, I want wrap-up to check whether a finding belongs in an existing written note before writing a new one, and offer `revise_note` instead, so that one idea stays in one note.
40. As an analyst, I want wrap-up to list every citation in this analysis's written notes labelled unverified, stale or missing, so that weak evidence is visible at the end of a session.
41. As an analyst, I want to choose, per note, verify now, keep or delete, so that I decide what happens to weak evidence.
42. As an analyst, I want "verify" to run a query that backs the number and update the citation with `revise_note`, so that the note cites the new run.
43. As an analyst, I want "verify" on a stale citation to rerun the trusted calculation with `trusted` and cite the new run, so that the number matches the current calculation.
44. As an analyst, I want "delete" offered only for notes this analysis wrote, so that one analysis never deletes another's findings.
45. As an analyst, I want wrap-up to ask at most four notes per question, so that the question fits on screen.
46. As an analyst, I want wrap-up to call `link_notes` for root notes it read this session that `analysis.yaml` does not record, so that `notes.found` is complete.
47. As an analyst, I want wrap-up to end with one line: open thread count, the next open thread, and notes written this session, so that I see where things stand.
48. As an analyst, I want wrap-up to write no denote note and run no `wiki-check`, so that root notes are the one record.
49. As an analyst, I want wrap-up to export nothing and make no slides, so that it stays a close-out.

### Citation labels for Claude

50. As an analyst, I want Claude to be able to ask for the label of each citation in this analysis's written notes, so that it can tell weak evidence from trusted evidence without guessing from files.
51. As an analyst, I want those labels derived the same way the app derives them, so that Claude and I see the same label for a citation.
52. As an analyst, I want the label tool to report a stale citation when the server can find the calculation's current commit, and say when it cannot, so that a missing git never reads as "all fresh".

### Docs

53. As a developer, I want the README's skills section to list `assay:resume`, `assay:wrap-up` and `assay:propose-trusted` with one line each, so that the plugin is documented.
54. As a developer, I want no mention of facts, `notes.md`, note files or the denote note left in the README or the skills, so that the docs match the code.

## Implementation Decisions

### The new skill, `assay:propose-trusted`

- **Invocation:** its description lets Claude invoke it on its own (a reusable query, or a missing dictionary entry)
  and the analyst call it with one argument. The argument is read as follows:
  - a number is a run;
  - a dotted three-part name is a table, meaning a dictionary entry;
  - a lower-case word is a calculation name, meaning change that calculation.
  - With no argument, the skill uses the latest run.
- **Steps:**
  1. **Read the source:**
     - For a run: the run's code and a few result rows, loaded with `q(N)` through the `python` tool. It never
       re-queries.
     - For a table: its schema (`discover-schema`) and the runs in this analysis that touch it.
     - For a name: the current files in the shared `trusted/`.
  2. **Pick the form:** a SQL template unless the run needed Python; a dictionary entry for a table. It refuses a
     name already in the shared `trusted/` unless the argument named it.
  3. **Write the files** into the analysis's drafts (trusted calculations, or dictionary entries), in the formats
     the checker reads:
     - **SQL:** front matter with a description and typed parameters, and `:param` placeholders.
     - **Python:** a function `<name>(engine, ...)` with a docstring and typed parameters, returning a data frame,
       plus pytest tests where the function needs them.
     - **Fixture:** `tables` (CSV text by table name), `cases` (args, and the expected result as CSV) and `live`
       (arguments).
     - **Dictionary entry:** description, columns, joins, and definitions with cases.
     - Fixture rows come from the run's result, trimmed, with identifying values replaced.
     - It refuses to overwrite an existing draft of the same name unless told to.
  4. **Self-check, without the checker:**
     - every placeholder is a declared parameter and every parameter is used;
     - every parameter has a type;
     - every case's args name declared parameters;
     - `live` is present;
     - every definition has a case;
     - names are lower case.
     - It may run pytest on a drafted Python calculation's own tests from the analysis folder. It does not run
       `analysis_trust`: Bash Python is refused, and Check is the analyst's.
  5. **Reply** with the files written and one line: open the Trust tab and press Check on `<name>`.
- **The skill's own format reference:** the skill holds a compact format reference, one minimal valid example per
  kind. The same examples are checked into the Python test fixtures (see Testing Decisions), so the skill and the
  checker cannot drift apart silently.

### Rules and server replies

- **Rules on each prompt:**
  - In the calculation rules, the drafting paragraph ("Propose a new trusted calculation in … Only the user promotes
    it") is replaced by one line: propose a trusted calculation or dictionary entry with the
    `assay:propose-trusted` skill; only the user promotes it in the Trust tab.
  - The trust rule's "Draft dictionary entries in …" line goes the same way.
  - The list of trusted calculations, and the rule never to write to the shared folders, stay.
- **The server's "no dictionary entry" hint:** the first touch of a table without an entry now says to draft it with
  the `assay:propose-trusted` skill and the table's full name, instead of listing the entry's fields. The hint for a
  name that is not three-part stays.

### The new tool, `note_labels`

- **`note_labels { id? }`:**
  - **Reply:** for each note in this analysis's `notes.written` (or the one `id`, which may be any root note), one
    line `<ID> <title>`, then one line per citation: `[<slug> q N] <label>`.
  - **Order and filter:** weak labels (unverified, stale, missing) are listed first. `weak: true` lists only notes
    with a weak citation.
  - **Labels:** they come from the core label function slice 7 added, which is shared with the app.
- **Stale in the server:** the server needs a calculation's current commit to tell trusted from stale.
  - The commit lookup the app uses (the latest git commit of the calculation's file in the shared `trusted/`) moves
    out of the app's main process into one place that the server and the app both call.
  - When git or the commit is unavailable, the reply ends with one line saying stale could not be checked, rather
    than calling the citation trusted silently.
  - This is the only new tool; the first draft of this spec said none. Wrap-up needs labels, and reading run files
    to guess them would duplicate the label rules in a prompt.

### Rewriting resume

- **What it reads:** `analysis.yaml` (title, `notes.written`, `notes.found`), the first line of each listed note,
  `threads.md`, and the code of the five highest-numbered runs. It does not read results.
- **Reply:** five lines at most.
- **Offering notes to link:** when `notes.found` is empty and the analysis has runs, it Greps the root notes for the
  tables and distinctive terms of those runs, then offers up to five candidates by title, newest first. It asks which
  to link with one question (multi-select), then calls `link_notes` with the chosen ones.
- **Then:** it asks which thread to take up. It runs no code.

### Rewriting wrap-up

1. Close answered threads and park new forks, as today.
2. List the verified findings without a note, each with its run. Offer `revise_note` on an existing written note when
   the finding extends it. Ask which to keep, then write each with `note`.
3. Call `note_labels { weak: true }`. For each note with a weak citation, ask verify / keep / delete with a
   structured question, up to four notes per question.
   - **Verify:** run the query (or `trusted` for a stale citation), then `revise_note` the citation to the new run.
   - **Delete:** `revise_note { delete: true }`, offered only for written notes.
4. Call `link_notes` for root notes Read this session and not recorded.
5. Reply with one line.

The denote-note step, the `wiki-check` step and every path under `~/Code/notes` are removed.

### Docs

- **README:**
  - The skills section lists the three skills.
  - The tools line adds `note_labels`.
  - Remaining mentions of facts, `notes.md`, note files and the denote note are removed.

## Testing Decisions

- **What a good test is:** a test checks external behaviour at the highest seam that exists: the prompt context a
  hook prints, a tool's reply over MCP, the checker's verdict on files. It never checks helper call shapes. Skills
  are prompts, so their wording is not unit-tested; the code around them is.
- **Hooks on stdin** (prior art: the hook tests that check prompt rules):
  - The prompt context carries the one-line pointer to `assay:propose-trusted`.
  - It no longer carries the drafting paragraph or the dictionary drafting line.
  - The trusted list is unchanged.
- **Server, MCP client over stdio** (prior art: the slice 5 dictionary first-touch tests and the slice 7 `note` /
  `revise_note` tests):
  - The first touch of a table without an entry names the skill.
  - `note_labels` lists each citation of the written notes with the label the core function gives: trusted,
    queried, computed, unverified, missing.
  - `weak: true` filters to weak notes.
  - With a fake commit lookup, a trusted citation whose calculation moved shows `stale`.
  - Without a lookup, the reply says stale was not checked.
- **Commit lookup:** once it is shared, the existing app test that builds a temporary git repo moves with it and runs
  against the shared function.
- **Draft format, Python tests** (prior art: the checker's tests):
  - One minimal valid example per kind (SQL template, Python function with pytest, dictionary entry with a
    definition), identical to the examples in the skill, passes `analysis_trust check`'s form and fixture steps.
  - A test reads the examples out of the skill file itself, so an edit to one without the other fails.
- **Plugin validity:** `claude plugin validate` on the plugin folder passes with the new skill, and each skill's
  front matter has a name and a description. Run it on the Mac with the real binary, as the README says. It is a
  checklist item, not an `npm test` case.
- **The usual gate:** `npm test`, `npm run typecheck` and `npm run build:server` pass.

## Out of Scope

- Any change to the Trust tab, the check steps or promotion (slice 5).
- Claude starting a Check, answering one, or promoting.
- Exporting a session summary anywhere outside the root. The denote note is dropped, not moved.
- Tools other than `note_labels`.
- The app showing labels differently. The app already labels citations (slice 7).
- Slice 7 follow-ups:
  - the same-second ID race when the app adds two notes;
  - repairing a torn note file in the migration;
  - a delete key in the Notes tab.
- Backlinks, tags or a graph of root notes.

## Further Notes

- **Mac checklist before merging (slices 7 and 8 together):**
  - Run `migrate:notes --apply` on the real root, then follow the slice 7 checklist.
  - Run `/assay:propose-trusted <run>` on a real run; Check in the Trust tab should pass without edits.
  - Run `/assay:propose-trusted <catalog.schema.table>` for a table without an entry.
  - Run `/assay:resume` on a migrated analysis (it should offer notes to link) and on a new one.
  - Run `/assay:wrap-up` with one unverified citation and choose verify; the note should then cite the new run with a
    `queried` or `trusted` label.
  - Run `claude plugin validate`.
- **Anonymising fixture rows** is a skill instruction, not a code check. If a draft is promoted with real IDs, the
  analyst removes them in review. A code check can come later if it happens.

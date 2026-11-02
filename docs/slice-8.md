# Slice 8 spec: trust drafting and skills for root notes (slice 4 of 4)

Slice 4 of the four agreed on 2026-11-02 (see `slice-5.md`, "The four slices"). Decisions below were settled in a
grilling session on 2026-11-02. Builds on slice 7 (root notes). The Trust tab's Check / Trust / Reject buttons
already shipped in slice 5.

## Problem Statement

Proposing a trusted calculation or a dictionary entry is a long rule repeated on every prompt, and Claude drafts
them inconsistently: missing fixture cases, untyped parameters, no `live` arguments, so the Trust tab's Check fails
for reasons the draft could have avoided. The resume and wrap-up skills still describe facts in `notes.md`, note
files and a denote note in `~/Code/notes/claude/`; after slice 7 none of that matches how an analysis records what
it learned.

## Solution

A new skill, `assay:propose-trusted`, drafts a trusted calculation or a dictionary entry in the analysis's
`lib/trusted/` or `lib/dictionaries/` with every file the Trust tab's Check needs, then tells the user to Check it
there. Claude invokes it when it has a reusable query or meets a table without a dictionary entry; the user can
invoke it with a run number or a table. The per-prompt rules shrink to one line pointing at it. `assay:resume` and
`assay:wrap-up` are rewritten for `analysis.yaml` and root notes; wrap-up no longer writes a denote note.

## User Stories

1. As an analyst, I want Claude to draft a trusted calculation from a query I keep reusing, so that the next analysis runs it with `trusted` instead of new SQL.
2. As an analyst, I want to type `/assay:propose-trusted 12` to draft one from run 12, so that I choose what becomes trusted.
3. As an analyst, I want `/assay:propose-trusted main.panel.surveys` to draft that table's dictionary entry, so that I can fill a gap I noticed.
4. As an analyst, I want Claude to start the skill on its own when a table has no dictionary entry or a query clearly generalises, so that drafts appear without my asking.
5. As an analyst, I want the draft to choose SQL template or Python function by what the run did, so that each calculation takes the simplest form that works.
6. As an analyst, I want a SQL template drafted with front matter, typed parameters and placeholders that match them exactly, so that the form check passes.
7. As an analyst, I want a Python function drafted with a docstring, an engine first and typed parameters, returning a data frame, so that the form check passes.
8. As an analyst, I want the draft to include a fixture file with small tables, at least one case and `live` arguments, so that Check runs tests and a live run.
9. As an analyst, I want fixture tables built from a few real rows of the run's result, trimmed and anonymised to what the case needs, so that cases are realistic but small.
10. As an analyst, I want a dictionary draft with description, columns (name, type, description) and joins from `discover-schema` and the analysis's queries, so that the entry's form check passes.
11. As an analyst, I want definitions in a dictionary draft only when a run in this analysis used them, each with a fixture case, so that every definition is tested.
12. As an analyst, I want the draft to check its own placeholders against its parameters before it finishes, so that obvious form errors are fixed before I press Check.
13. As an analyst, I want the skill to end by naming the proposal and telling me to press Check in the Trust tab, so that I know the next step.
14. As an analyst, I want Claude never to Check, Trust or Reject a proposal, so that promotion stays mine.
15. As an analyst, I want the skill to refuse a name that already exists in `trusted/`, unless I asked to change that calculation, so that drafts do not shadow trusted ones by accident.
16. As an analyst, I want the per-prompt rules to point at the skill instead of repeating the drafting rules, so that every prompt carries less text.
17. As an analyst, I want `/assay:resume` to read `analysis.yaml`, the threads and the five latest runs, so that it fits the root layout.
18. As an analyst, I want resume to report the analysis title, its written notes (count and latest titles), its found notes (count), the open threads and the latest run, in at most five lines, so that I pick up quickly.
19. As an analyst, I want resume, on an analysis with no found notes, to search the root notes and offer the relevant ones to link, so that an older analysis also benefits from past findings.
20. As an analyst, I want resume to ask which thread to take up and run no code, so that it stays a read-only start.
21. As an analyst, I want `/assay:wrap-up` to close answered threads and park new forks, so that `threads.md` is current.
22. As an analyst, I want wrap-up to list findings this session verified that no note holds yet, and write the ones I keep with `note`, so that findings reach the root notes.
23. As an analyst, I want wrap-up to list every citation labelled unverified in this analysis's written notes and ask, per note, verify now, keep or delete, so that weak evidence is dealt with.
24. As an analyst, I want "verify" to run a query and update the citation with `revise_note`, so that the note cites the new run.
25. As an analyst, I want wrap-up to link with `link_notes` any root note it read this session but has not recorded, so that `notes.found` is complete.
26. As an analyst, I want wrap-up to end with one line: open thread count, the next thread, notes written this session, so that I see where things stand.
27. As an analyst, I want wrap-up to write no denote note and run no `wiki-check`, so that root notes are the one record.

## Implementation Decisions

- **New skill `assay:propose-trusted`** in the plugin's skills. Its description lets Claude invoke it (reusable
  query, missing dictionary entry) and the user call it with a run number, a calculation name or a
  `catalog.schema.table`. Steps:
  1. Read the source: the run's `.sql`/`.py` and a few result rows (with `q(N)` through the `python` tool when
     needed), or the table's schema (`discover-schema`) and the analysis's runs touching it.
  2. Pick the form: SQL template unless the run needs Python; a dictionary entry for a table.
  3. Write the files under the analysis's `lib/trusted/` or `lib/dictionaries/` in the formats the Python helpers
     check (front matter, types, docstring, fixture `tables`/`cases`/`live`, definitions with cases), the same
     formats the mod's README documents.
  4. Self-check what needs no Python: placeholders equal declared parameters, every definition has a case, names
     are lower case. It does not run `analysis_trust` (Bash Python is refused, and Check belongs to the user); it
     may run `pytest` on a drafted `test_<name>.py` from the analysis folder.
  5. Reply with the files written and one line: open the Trust tab and press Check on `<name>`.
- **Rules on each prompt**: the drafting paragraph in the calculation rules is replaced by one line: propose a
  trusted calculation or dictionary entry with the `assay:propose-trusted` skill; only the user promotes it in the
  Trust tab. The list of trusted calculations stays.
- **`assay:resume` rewrite**: reads `analysis.yaml` (title, `notes.written`, `notes.found`), the titles of those
  notes (first line only), `threads.md`, and the code of the five highest-numbered runs. Five lines at most, then
  asks which thread to take up. If `notes.found` is empty and the analysis has runs, it Greps `<root>/notes` for
  the tables and topics of those runs, lists up to five candidates by title, and asks which to link (then
  `link_notes`). Runs no code.
- **`assay:wrap-up` rewrite**: (1) close answered threads and park new forks, as today; (2) list verified
  findings without a note, ask which to keep, write each with `note`; (3) for each written note with an
  `unverified` citation, ask verify / keep / delete (`AskUserQuestion`, up to four per call): verify runs the
  query and `revise_note`s the citation, delete calls `revise_note { delete: true }`; (4) `link_notes` for root
  notes read this session and not recorded; (5) one-line reply. The denote-note and `wiki-check` steps are
  removed.
- **Server**: no new tools. Tool replies that offered the dictionary drafting rule now name the skill instead.

## Testing Decisions

- Skills are prompts; test what the code around them does, at the existing seams.
- **Hooks on stdin**: the prompt context carries the one-line pointer to `assay:propose-trusted` and no longer
  the drafting paragraph; the trusted list is unchanged. Prior art: slice 5's hook tests.
- **Server, MCP client over stdio**: the first touch of a table without an entry names the skill. Prior art:
  slice 5's dictionary first-touch tests.
- **Plugin validity**: `claude plugin validate` on the plugin folder (the real binary, as the README says) passes
  with the new skill; each skill's front matter has a name and description.
- **Draft format**: a fixture draft written as the skill instructs (checked into the test fixtures) passes
  `analysis_trust check` in the Python tests, so the skill's documented format and the checker agree. Prior art:
  `python/tests/test_analysis_trust.py`.
- `npm test`, `npm run typecheck` and `npm run build:server` pass.

## Out of Scope

- Any change to the Trust tab, the check steps or promotion (slice 5).
- Claude starting a Check or answering one.
- Exporting a session summary anywhere outside the root (the denote note is dropped, not moved).
- New MCP tools.

## Further Notes

- Mac checklist before merging: `/assay:propose-trusted <run>` on a real run, then Check in the Trust tab passes
  without edits; `/assay:propose-trusted <table>` for a table without an entry; `/assay:resume` on a migrated
  analysis and on a new one; `/assay:wrap-up` with one unverified citation, choosing verify.
- After this slice, update the README's skills section and delete any remaining mention of facts, `notes.md` and
  the denote note.

# Slice 7 spec: Zettelkasten root notes (slice 3 of 4)

Slice 3 of the four agreed on 2026-11-02 (see `slice-5.md`, "The four slices"). Decisions below were settled in a
grilling session on 2026-11-02. Builds on slice 6 (`analysis.yaml`, Claude in the root).

## Problem Statement

What an analysis learns is locked inside it, in two shapes: one-line facts in `notes.md` and prose files in
`notes/NNN-<slug>.md`. A new analysis starts blind to what earlier analyses found about the same tables, metrics or
panels, and the two shapes need two sets of tools, two renderers and two sets of rules. Citations (`[q 12]`) only
make sense inside their own analysis, so a finding cannot travel.

## Solution

One kind of note, shared by every analysis: `<root>/notes/<ID>-<slug>.md`, where the ID is a denote-style
timestamp (`20261102T181500`). Notes link each other by ID (`[[20261102T181500]]`) and cite runs with the analysis
named (`[churn-q3 q 12]`), so a note means the same thing from anywhere. A fact is just a short note. Claude writes
notes only through note tools; after the first query of a new analysis it searches the root notes and links the
relevant ones. `analysis.yaml` lists the notes the analysis wrote and the ones it found, and a new Notes tab shows
those two groups. Provenance labels are derived per citation whenever a note is read; nothing stores them. A
one-off migration turns every analysis's `notes.md` facts and note files into root notes.

## User Stories

1. As an analyst, I want every finding stored as a root note, so that later analyses can find it.
2. As an analyst, I want a fact to be a short root note (its title the fact), so that there is one kind of note to read, search and link.
3. As an analyst, I want each note named `<ID>-<slug>.md` with a timestamp ID, so that notes sort by time and links survive a title change.
4. As an analyst, I want links written as `[[<ID>]]` and shown as the linked note's title, so that links read naturally and never break on a rename.
5. As an analyst, I want citations written as `[<slug> q N]`, so that a note cites the right run from any analysis.
6. As an analyst, I want a bare `[q N]` Claude writes to be qualified with the open analysis's slug on save, so that no unqualified citation reaches disk.
7. As an analyst, I want each citation shown with its provenance label (trusted, queried, computed, unverified, stale), so that I see how well a number is backed.
8. As an analyst, I want labels derived from the cited run each time a note is read, so that no stored label can drift from the run.
9. As an analyst, I want a citation to a missing analysis or run shown as missing, so that broken evidence is visible.
10. As an analyst, I want Claude to write a new note with `note { title, text }`, so that every note gets an ID, a slug and qualified citations from the server.
11. As an analyst, I want Claude to change a note with `revise_note { id, old, new }`, an exact replacement, so that a note I edited since Claude read it is not silently overwritten.
12. As an analyst, I want `revise_note { id, delete: true }` to delete only notes the open analysis wrote, so that one analysis cannot delete another's findings.
13. As an analyst, I want Claude's Write and Edit calls into `<root>/notes` refused, so that every note change goes through the tools.
14. As an analyst, I want the tools to reply with unknown runs and unresolved links, so that Claude fixes them before moving on.
15. As an analyst, I want the first query of a new analysis to tell Claude to search the root notes and link the relevant ones, so that past findings are pulled in at the start.
16. As an analyst, I want Claude to record found notes with `link_notes { ids }`, so that `analysis.yaml` says which past notes this analysis relied on.
17. As an analyst, I want `analysis.yaml` to list `notes.written` and `notes.found` by ID, so that each analysis's notes are known without scanning every note.
18. As an analyst, I want the Notes tab to show this analysis's written notes and found notes as two groups, by title, newest first, so that I see its own work and its sources apart.
19. As an analyst, I want to open a note in the reader, follow its `[[ID]]` links and see its labelled citations, so that I can read through the evidence.
20. As an analyst, I want a citation to a run in the open analysis to jump to that run in the Code and Data tabs, so that I can check it as today.
21. As an analyst, I want a citation to another analysis's run to open a preview of that run's code and result, so that I can check it without switching analysis.
22. As an analyst, I want to edit a root note in the app's reader with the same editor and stale-save guard as note files today, so that my workflow does not change.
23. As an analyst, I want to add a note from the Notes tab (title and text), recorded under written, so that I can note a finding without asking Claude.
24. As an analyst, I want universal search (Cmd+F) to cover every root note, so that I can find notes no analysis has linked yet.
25. As an analyst, I want a note citing a trusted run whose calculation changed to show `stale`, so that the trust check keeps working across analyses.
26. As an analyst, I want threads to stay per analysis in `threads.md`, so that open questions belong to the analysis that raised them.
27. As an analyst, I want code, runs and drafts to stay in the analysis, so that only prose moves to the root.
28. As an analyst, I want one command that shows, per analysis, which facts and note files would become which root notes, so that I can check the migration first.
29. As an analyst, I want `--apply` to turn each fact into its own root note and each note file into a root note, with links and citations rewritten, so that nothing found so far is lost.
30. As an analyst, I want migrated notes listed under `notes.written` of their analysis, so that the new Notes tab shows them at once.
31. As an analyst, I want `notes.md` and the analysis's `notes/` removed only after their root notes are written, so that a failed run leaves the old files.
32. As an analyst, I want a rerun of the migration to change nothing, so that it is safe to repeat.
33. As a developer, I want facts, `notes.md`, the fact tools and the fact renderer gone, so that one note kind is left to maintain.

## Implementation Decisions

- **Root note file**: `<root>/notes/<ID>-<slug>.md`. ID is `YYYYMMDDTHHMMSS` (local time) when written; if taken,
  bump by one second. Slug from the title with the existing `slugify`. Content: `# <Title>`, a blank line, the body.
  No front matter. The title may change; the file name does not.
- **Inline syntax**: links `[[<ID>]]`; citations `[<analysis-slug> q <N>]`. Fenced code is left alone, as in
  today's note parser. The old `[[slug]]` and `[q N]` forms are not parsed after migration.
- **Labels**: one core function derives a citation's label from the cited analysis's run files, the same rules as
  today's fact labels (`trusted` / `queried` / `computed` / `unverified`, `stale` for a trusted run whose
  calculation has a newer commit), plus `missing` for an unknown analysis or run. Server replies and the app both
  use it. Nothing is written to the note.
- **Core module for root notes**: replaces the facts module and the note-files module. Owns: ID generation and
  collision bump, file name parse/format, title/body split, segment parsing (text, link, citation), qualifying
  bare citations with a slug, the exact-replacement edit with its stale error, and the `notes` lists of
  `analysis.yaml` (add written, add found, remove written). One module, used by the server, the app and the
  migration.
- **`analysis.yaml`** gains:

  ```yaml
  notes:
    written: [20261102T181500, 20261102T183012]
    found: [20261001T090000]
  ```

  A note is in at most one list per analysis; `link_notes` ignores IDs already written by this analysis.
- **MCP tools** (Claude sees `mcp__plugin_assay_assay__<name>`):

  | Tool | Behaviour |
  | :- | :- |
  | `note { title, text }` | Writes a new root note, qualifies bare citations, adds it to `notes.written`. Replies `Wrote notes/<file>. Link it with [[<ID>]].` plus `Unknown runs: …` and `Unresolved links: …` when they apply (neither refuses). |
  | `revise_note { id, old, new }` or `{ id, title }` or `{ id, delete: true }` | Exact single replacement in the body (refused when `old` is absent or not unique, telling Claude to Read again); a title change; or delete, only for notes in this analysis's `written`, removing it from the list. Same warnings as `note`. |
  | `link_notes { ids }` | Adds existing root notes to `notes.found`; refuses unknown IDs, naming them. |

  `new_note` and `link_note` are removed; `note` and `revise_note` change meaning as above.
- **Searching the root notes**: Claude uses Grep and Read on `<root>/notes` (read-only tools, allowed). The first
  `sql`, `python` or `trusted` run of an analysis whose `notes.found` and `notes.written` are both empty ends its
  reply with one line: search `notes/` for notes about the tables and topics of this run and call `link_notes`
  with the relevant IDs. Once per session.
- **Rules on each prompt**: replace the note-file and `notes.md` rules with: findings go to root notes through
  `note`, one idea per note, every number cited `[<slug> q N]`, related notes linked `[[ID]]`; change a note with
  `revise_note` after reading it; never Write or Edit under `notes/`.
- **Hooks**: PreToolUse on `Write|Edit|NotebookEdit` denies paths under `<root>/notes/`.
- **App**:
  - The Notes tab is replaced: two groups, Written and Found, each newest first, title plus age, a count in the
    tab label. `a` adds a note (title, text) written by the app (same file rules, added to `written`).
  - The reader renders a root note: `[[ID]]` as the linked title (unresolved shown plainly), citations with label
    colours (as today's fact labels). A citation in the open analysis focuses the run; one in another analysis
    opens a preview of its `.sql`/`.py` and result.
  - Editing in the reader keeps today's editor and stale-save guard (mtime and size), now on root notes.
  - Universal search indexes `<root>/notes/*.md`.
  - The app watches `<root>/notes` and `analysis.yaml` the way it watches note files today.
- **Server activation** no longer creates `notes.md` or `notes/`, and stops relabelling facts.
- **Migration script** (`npm run migrate:notes`, dry run by default, `--apply`, the root as an optional argument;
  requires slice 6's migration to have run): per analysis, in order:
  1. Each note file `notes/NNN-<slug>.md` becomes a root note with an ID from its mtime (bumped on collision),
     same title and body; `[[slug]]` links between that analysis's files become `[[ID]]`; `[q N]` becomes
     `[<analysis-slug> q N]`.
  2. Each `notes.md` fact becomes its own root note: title the fact text without its label, body the same text
     with `[<analysis-slug> q N]` when it cited a run. IDs from `notes.md`'s mtime minus the line count, one
     second apart in line order, so they sort as written. A link line `[Title](<path>)` becomes a root note
     titled `Title` whose body is the Markdown link.
  3. All of them go into `notes.written`; then `notes.md` and `notes/` are removed.
  It prints one line per note it would write and lists unresolved links. A rerun changes nothing (an analysis
  without `notes.md` or `notes/` is skipped). It does not touch git.

## Testing Decisions

- Test external behaviour at the highest seam: files on disk, tool replies, hook decisions, rendered segments; not
  helper call shapes.
- **Core**: ID generation and bump; file name round trip; segment parsing (links, citations, fenced code);
  qualifying bare citations; exact-replacement edits and their stale/ambiguous errors; label derivation for each
  label including `stale` and `missing`; `notes` lists in `analysis.yaml`. Prior art: `facts.test.ts`,
  `noteFiles.test.ts`, slice 5's `modModel.test.ts`.
- **Server, MCP client over stdio** (prior art: `mcp.test.ts`, `tools.test.ts`): `note` writes the file and
  updates `written`; bare `[q 3]` is qualified; unknown runs and links are reported; `revise_note` replaces,
  refuses a missing `old`, refuses deleting a found note; `link_notes` refuses unknown IDs; the first run of an
  empty analysis carries the search line once.
- **Hooks on stdin**: a Write under `<root>/notes` is denied; the prompt rules name the new tools.
- **Migration**: a scratch root with two analyses holding facts (labelled, bare, unlabelled, a link line) and
  note files linking each other; compare the resulting `notes/` tree, each `analysis.yaml` and the report; a rerun
  changes nothing. Never run against `~/Code/notes-src`.
- `npm test`, `npm run typecheck` and `npm run build:server` pass.

## Out of Scope

- Rewriting resume and wrap-up for root notes, and the drafting skill (slice 8). This slice only removes their
  references to tools that no longer exist (`new_note`, fact `note`) with minimal edits.
- Moving threads, runs, code or drafts to the root.
- Linking notes to notes in other repositories (the old `link_note`).
- Tags, backlink panes, or a graph view of notes.

## Further Notes

- Choosing the exact-replacement form for `revise_note` (instead of a whole-body replace) was made while writing
  this spec, to give the stale guard the grilling asked for "Claude reads first"; change it in review if needed.
- Mac checklist before merging: dry run, then `--apply`, of `migrate:notes` on the real root; open an old analysis
  and see its migrated notes under Written with labels; start a new analysis, run one query, and see Claude call
  `link_notes`; `note` from Claude shows up at once; a Write into `notes/` is refused; edit a note in the app and
  then have Claude `revise_note` it with stale text (refused).

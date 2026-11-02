# Slice 6 spec: the root layout (slice 2 of 4)

Slice 2 of the four agreed on 2026-11-02 (see `slice-5.md`, "The four slices"). Decisions below were settled in a
grilling session on 2026-11-02. Builds on slice 5 (branch `slice-5`, `87614be`): it must be merged first.

## Problem Statement

An analysis is marked by an empty `.analysis` file and named only by its folder, so the picker shows terse folder
names and a new analysis must be named like a folder. Older work is split across three parents (`analyses/`,
`investigations/`, `explorations/`), so the picker, the skills and the server each carry rules for all three. And
Claude starts inside one analysis folder, so it cannot see anything at the root (the shared notes that slice 7
adds, the dictionaries, other analyses) without leaving its working directory.

## Solution

Every analysis is `<root>/analyses/<slug>/` with an `analysis.yaml` holding a typed title (and the target settings
that `.analysis` held). The user types a title when creating an analysis; the folder slug is derived from it once
and never changes. Claude starts in the root, with the open analysis named for it. A one-off migration script turns
every `.analysis` into `analysis.yaml` and moves the marked `investigations/*` and `explorations/*` into
`analyses/`. After it, only `analyses/` exists for the app, the server and the skills.

## User Stories

1. As an analyst, I want to type a title like "Churn in Q3" when I create an analysis, so that I name it as I think of it, not as a folder.
2. As an analyst, I want the folder slug derived from the title for me, so that I never think about valid folder characters.
3. As an analyst, I want a title that slugs to an existing folder to get a numbered slug (`churn-in-q3-2`), so that creating never fails on a name clash.
4. As an analyst, I want the picker to list analyses by title, newest first, so that I recognise them at a glance.
5. As an analyst, I want the picker's fuzzy search to match titles and slugs, so that I find an analysis by either.
6. As an analyst, I want to edit an analysis's title, so that it can follow what the analysis turned out to be about.
7. As an analyst, I want editing the title never to rename the folder, so that citations naming the slug never break.
8. As an analyst, I want the window title and the workspace header to show the analysis title, so that I always know which analysis is open.
9. As an analyst, I want the profile, warehouse and Postgres database still settable per analysis in `analysis.yaml`, so that targets work as with `.analysis`.
10. As an analyst, I want an analysis without these keys to use the same defaults as today, so that nothing changes for most analyses.
11. As an analyst, I want Claude to start in the root folder, so that it can read the shared dictionaries, trusted calculations and (in slice 7) root notes.
12. As an analyst, I want Claude told on every prompt which analysis is open and where its files are, so that it writes runs, `lib/`, `tests/` and drafts in the right place.
13. As an analyst, I want Claude's Write and Edit calls into another analysis refused, so that working in the root never touches an analysis I did not open.
14. As an analyst, I want the kernel's working directory to stay the analysis folder, so that `from lib.<name> import ...` and `q(N)` work as today.
15. As an analyst, I want runs, threads, notes and `.assay/` to stay inside the analysis folder, so that the app's file contract is unchanged.
16. As an analyst, I want one command that shows what the migration would change, per folder, without changing anything, so that I can check it first.
17. As an analyst, I want `--apply` to write `analysis.yaml` from each `.analysis` (keeping its keys) with a title made from the folder name, so that old analyses open with readable titles.
18. As an analyst, I want marked investigations and explorations moved into `analyses/`, so that every analysis lives in one place.
19. As an analyst, I want a moved folder whose slug clashes to get a numbered slug and be named in the report, so that nothing is overwritten.
20. As an analyst, I want unmarked folders in `investigations/` and `explorations/` left alone and listed in the report, so that I decide about them myself.
21. As an analyst, I want a rerun of the migration to change nothing, so that running it twice is safe.
22. As an analyst, I want `.analysis` removed after its `analysis.yaml` is written, so that there is one marker.
23. As an analyst, I want the app to refuse to open a folder without `analysis.yaml` and point me at the migration, so that half-migrated folders are obvious.
24. As an analyst, I want the resume and wrap-up skills to keep working after the move, so that this slice breaks no session (their rewrite is slice 8).
25. As a developer, I want `investigations/`, `explorations/` and `.analysis` gone from the app, the server and the skills, so that one layout is left to maintain.

## Implementation Decisions

- **The root** is the Settings folder (today's `ASSAY_ROOT`, the one holding `analyses/`, `dictionaries/`,
  `trusted/`). Analyses are only `<root>/analyses/<slug>/`.
- **`analysis.yaml`** replaces `.analysis`. Shape (slice 7 adds `notes`):

  ```yaml
  title: Churn in Q3
  created: 2026-11-02
  profile: Cint mkt          # optional, as in .analysis
  warehouse: 455a178462311474 # optional
  pg_database: panel          # optional
  ```

  The slug is the folder name, never stored. It is `slugify(title)` (the existing note-slug rule in core) at
  creation, with `-2`, `-3`, … on a clash. A title edit rewrites `title:` only.
- **Core module for analyses** (the existing analysis-listing module): reads and writes `analysis.yaml`
  (parse, validate, keep unknown keys and comments where the YAML library allows), lists `analyses/*` holding it
  with title and mtime, creates one from a title. The `investigations`/`explorations` parents and the `.analysis`
  marker are removed from it. The server's target settings (profile, warehouse, pg_database) read from the same
  parser.
- **App**: the picker shows titles and takes a title for a new analysis; a "Rename analysis" palette command edits
  the title; window title and header show it. `spawnSpec` sets the cwd to the root. `ASSAY_ROOT` and
  `ASSAY_ANALYSIS` are unchanged (the slice 5 seams), so the server needs no new environment.
- **Server**: unchanged in where it writes (always under `ASSAY_ANALYSIS`). Activation requires `analysis.yaml`
  (and no longer creates a marker). Tool results that name files give paths relative to the root
  (`analyses/<slug>/queries/012_x.sql`) so Claude can Read them from its cwd.
- **Rules on each prompt** gain one line: the open analysis's title and folder (`analyses/<slug>/`), that its
  `lib/`, `tests/`, `lib/trusted/` and `lib/dictionaries/` are there, and that tests run from that folder
  (`cd analyses/<slug> && <python> -m pytest tests`).
- **Hooks**: PreToolUse on `Write|Edit|NotebookEdit` also denies paths under `<root>/analyses/` outside
  `ASSAY_ANALYSIS`, with a one-line reason naming the open analysis.
- **Skills**: minimal path fixes only, so they work from the root (`analysis.yaml` instead of `.analysis`, files
  under `analyses/<slug>/`). Their rewrite is slice 8.
- **Migration script** (`npm run migrate:root`, dry run by default, `--apply` to act, the root as an optional
  argument, default the Settings folder): for every `analyses/*` with `.analysis` and every marked
  `investigations/*` and `explorations/*`, write `analysis.yaml` (keys from `.analysis`, `title` from the folder
  name: hyphens and underscores to spaces, first letter upper case; `created` from the oldest run file, else the
  folder's mtime), move the folder to `analyses/<slug>` when it is not there, then remove `.analysis`. It prints
  one line per folder and a list of what it left alone. It never overwrites; a rerun changes nothing. It does not
  touch git. The old mod's `investigations/CLAUDE.md` copying is not carried over.

## Testing Decisions

- Good tests check behaviour at the highest seam: what a user or Claude sees (files on disk, tool replies, hook
  decisions), not internal functions' call shapes.
- **Core**: `analysis.yaml` parse/write round trip (unknown keys kept), slug derivation and clash numbering,
  listing order, creating from a title, refusing a folder without `analysis.yaml`. Prior art: the existing
  analysis-listing tests and `settings.test.ts`.
- **Server, MCP client over stdio** (prior art: slice 5's `mcp.test.ts`): a scratch root with an analysis, the
  server started with the cwd at the root; `sql` and `python` still write under the analysis and reply with
  root-relative paths; target settings come from `analysis.yaml`.
- **Hooks on stdin** (prior art: slice 5's hook tests): a Write into another analysis is denied; into the open one
  is allowed; the prompt context names the analysis.
- **Migration**: run on a scratch copy of a root with `analyses/`, marked and unmarked `investigations/*` and
  `explorations/*`, and a slug clash; compare the resulting tree and report; a second run changes nothing. Never
  run against `~/Code/notes-src`.
- `npm test`, `npm run typecheck` and `npm run build:server` pass.

## Out of Scope

- Root notes, merging facts into notes, `link_notes`, the new Notes tab (slice 7).
- Rewriting resume and wrap-up, the drafting skill (slice 8).
- Renaming a folder when the title changes; moving `.assay/`, runs or threads out of the analysis.
- Committing the migration in the root's git repository (the user does it).

## Further Notes

- The hook that denies writes into other analyses was not discussed in the grilling; it follows from "Claude
  starts in the root" and the one-rule-above-all. Drop it in review if unwanted.
- Mac checklist before merging: run the migration dry, then `--apply`, on the real root; open an old investigation
  by its new title; create "Churn in Q3" and see `analyses/churn-in-q3/analysis.yaml`; a `python` run imports
  from `lib/`; a Write into another analysis is refused.

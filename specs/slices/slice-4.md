# Slice 4 spec: Zettelkasten notes and the trust review

Implements "Build slices" item 4 of `HANDOFF.md`, plus the user's request of 2026-11-02 that the trust review leaves the
mod pane. Read `HANDOFF.md` first (it wins on product intent; "Decided while building" overrides older parts), then
`specs/slices/slice-3.md` for the layout of the code, IPC and tests.

Fixed points: assay `39fbb20`, config `dd5dae2`.

## Build environment

- App (`~/Code/assay`): `npm test` and `npm run typecheck` must pass. New dependency allowed: `@codemirror/lang-markdown`.
- Mod (`~/Code/config/claude/analysis`): `cd ~/Code/config/claude/analysis && /opt/homebrew/bin/claude plugin test .`
  (plain `claude` is the Podman wrapper). Mod API types: `types/` and the full copy at
  `~/Code/config/claude/investigate/.claude-plugin/types/claude-code/index.d.ts` (`$.ui.ask` is at about line 2452).
  Gotchas: `~/Code/config/LEARNINGS.md`.
- Helper (`notes-src/analysis_trust.py`): pytest with venv-assay's packages. Build a scratch venv with `uv` under the
  session's scratch folder from `notes-src/pyproject.toml` (as `notes-src/tests/test_venv.sh` does), and run
  `<venv>/bin/python -m pytest notes-src/tests/test_analysis_trust.py`. Never create or change a venv in `~/Code/notes-src`.
- In `~/Code/config` commit only this slice's files, staged by explicit path. `nvim/` holds the user's uncommitted
  changes: never stage, stash, reset or check them out. If a commit fails on `index.lock`, wait a second and retry.
- Constraints: the app keeps no database; files are the contract. The mod stays the backend: reuse `runQuery`,
  `deriveLabel`, the `sql` tool, `parsePythonRun`; do not fork them. venv-assay runs the mod's tools.

## What the user gets

1. Claude writes prose findings as Zettelkasten notes, `notes/NNN-<slug>.md`, linked with `[[slug]]` and citing runs
   with `[q 012]`.
2. The Notes tab lists the facts of `notes.md` and the note files. A note file opens in a reader that shows each
   citation's run label, follows links and citations by keyboard, and lists backlinks.
3. The user creates, edits (CodeMirror, Vim mode) and deletes note files from the Notes tab.
4. `/an trust <name>` in the app shows the review in a new **Trust** tab of the data pane, live, like pytest output.
   The approval is Claude Code's own question dialog, asked by the mod. The mod's pane never opens in the app.
5. Outside the app the pane shows the same review without `y`/`r`, and approval uses the same dialog.
6. Approving an unchanged calculation says `Already trusted: no changes` instead of failing.

## Part 1: note files

### The contract

```
notes/NNN-<slug>.md
```

- `NNN` is three digits or more (`001`); `<slug>` is lower case letters, digits and `-`, starting with a letter or digit.
  A name that does not match is not a note file (ignored by both sides).
- The first line is `# <Title>`. A file without it takes its slug as the title.
- A link is `[[<slug>]]` or `[[NNN-<slug>]]`; it resolves to the note file with that slug (or that whole stem). An
  unresolved link is shown as missing; it is not an error.
- A citation is `[q 12]` or `[q 012]` (also inside a fact's label tag, as today). It names one run, SQL or Python.
- The file carries no trust label. The app shows each cited run's label beside its citation.
- Numbers: the next note is the highest `NNN` in `notes/` plus one. Slugs are unique in `notes/`.
- `notes.md` keeps one-line facts and the existing `[Title](<path>)` link lines (`link_note`). Note files in `notes/`
  are not listed in `notes.md`.

### Mod (config repo, `claude/analysis`)

- **`new_note` tool** (`mcp__analysis__new_note`): `{ title: string, slug: string, text: string }`. Checks the slug
  (pattern above), refuses a slug already used (`A note <slug> exists: notes/003-<slug>.md. Edit it with Edit.`), claims
  the next number, creates `notes/` if missing, and writes `# <title>\n\n<text>\n` (trimmed). Replies
  `Wrote notes/004-<slug>.md. Link it from other notes with [[<slug>]].`, plus one line each, when present:
  `Unknown runs: 099, 120.` (citations with no run in `queries/`) and `Unresolved links: [[foo]].` They do not refuse.
  Pure helpers in `model.ts` (note file name parse, next number, links and citations in a text) with table tests.
- **Rules** (`analysisRules`): write prose findings, explanations and anything longer than a fact as notes with
  `new_note`, one idea per note; link related notes with `[[slug]]`; cite every number with `[q NNN]`; to change a note
  read it, then `Edit` it (the user edits them too); `notes.md` stays one line per fact via `note`.
- **Setup and activation** create `notes/` when missing, never overwriting (with the others in `setUp`).
- **`skills/resume/SKILL.md`** reads the titles of `notes/` (first lines) and mentions how many notes there are.
- **`README.md`**: `notes/` in Files, `new_note` in Claude's tools, the rule. The mod's pane does not show note files.

### App (`~/Code/assay`)

**Core (pure, `node:test` first).** New `core/noteFiles.ts`:

- `parseNoteFileName(name) -> { number, slug } | undefined`, `nextNoteNumber(names)`, `slugify(title)` (lower case,
  runs of other characters to `-`, trimmed, at most 60 characters; empty gives `note`), `noteFileName(number, slug)`.
- `parseNoteFile(name, text, stat) -> NoteFile`: `{ name, number, slug, title, links: string[], citations: number[],
  mtimeMs, size }` (links and citations in order of first appearance, outside fenced code blocks; `mtimeMs` and `size`
  let the reader re-read only when its file changed).
- `noteSegments(text)`: the body split into plain text, `link` (target) and `citation` (number) segments, for the reader.
- `resolveLink(target, notes) -> NoteFile | undefined` and `backlinks(note, notes) -> NoteFile[]` (by number order).

**Main.**

- `loadState` lists `notes/` and reads each note file (they are small; cache by mtime and size). `AnalysisState`
  gains `noteFiles: NoteFile[]` in number order. The poll sees new, changed and deleted note files.
- IPC `noteFiles.read(name) -> { ok, text } | { ok: false, message }`, `noteFiles.create(title) -> { ok, name }`
  (number and slug derived; slug clash gets `-2`, `-3`; written with the `wx` flag, so it never overwrites),
  `noteFiles.save(name, expectedText, text) -> EditResult` (stale when the file changed since it was read; writes
  atomically), `noteFiles.delete(name, expectedText) -> EditResult`. Names outside `notes/` or not matching the
  pattern are refused (`resolveInside`).

**Renderer: Notes tab.**

- The list shows the facts, then a `Note files` group with each note file's title and its number (`004`), oldest first.
  `j`/`k`, `/` search over both. `a`, `e`, `d` act on facts as today.
- On a note file: `Enter` opens the reader; `n` (anywhere in the list) asks for a title and creates a note, then opens
  its editor; `e` opens its editor; `d` asks `Delete "<title>"? y to confirm` and deletes it.
- **Reader:** the title, then the body as text with headings, paragraphs and fenced code (monospace) kept readable.
  Links and citations are marked: a citation shows `q 012` with its run's label chip (`trusted`, `queried`,
  `computed`, `unverified`, `running`, from `runLabel`; `no run` when missing); a link shows the title of its target
  (`missing` when unresolved). `Tab` / `Shift+Tab` move between links and citations; `Enter` follows: a link opens that
  note (Backspace goes back through the notes opened this way), a citation makes that run the data pane's current run
  (held, as choosing it in History does) and focuses the data pane. `Linked from` at the bottom lists backlinks, also
  reachable with `Tab`. `j`/`k` scroll; `e` edits; `Esc` back to the list.
- **Editor:** CodeMirror 6 with Markdown highlighting and Vim mode, as the Code tab's editor. `Cmd+S` saves; a stale
  save copies the unsaved text to the clipboard, says `Changed on disk, reloaded. Your edit is on the clipboard.` and
  reloads the file into the reader. `Esc` in Vim normal mode leaves; with
  unsaved changes it asks `Discard changes? y / n`.
- The facts' existing `[Title](<path>)` link rows keep their behaviour.
- Facts that cite a run (`q 12`) keep their label; nothing new there.
- `PANE_KEYS` gains the Notes keys (`n`, note reader, editor).

## Part 2: the trust review

### Helper: `analysis_trust.py check --stream`

`check <folder> <name> <analysis>` and `check-entry <draft> <analysis>` take an optional `--stream` last argument.
With it, the command prints one JSON line per event as it happens, flushing each:

```json
{"event": "start", "name": "x", "kind": "sql|python|dictionary", "file": "x.sql", "description": "...", "code": "...", "files": ["x.sql", "x.test.yaml"]}
{"event": "step", "step": {"step": "form|transpile|test|tests|live", "ok": true, "text": "...", "name": "case 1", "diff": "..."}}
{"event": "done", "answer": { ...the same CheckAnswer the command prints without --stream... }}
```

`start` comes once the form was read (a form failure gives a `step` then `done`, no `start`). An unexpected exception
prints `{"event": "done", "answer": {"error": "..."}}`. Without `--stream` the output is unchanged in shape (one
`CheckAnswer` object), but its steps change as below.

Steps:

- `form`: also on success, for a calculation (`SQL template, 2 parameters` / `Python function, 1 parameter`), as for an
  entry today.
- `transpile`: as today.
- `test`, one per test, replacing the single `tests` step: `name` is `case N` (1-based) for a fixture case, or
  `test_x.py::test_y` for the calculation's own pytest; `text` is `PASSED` or `FAILED` and, on failure, the assertion's
  first line; `diff`, on a fixture case's failure, a line diff of expected and got as CSV (`  ` same, `- ` expected only,
  `+ ` got only; columns first, at most 40 lines, then `… N more`). Each test's step streams when pytest reports it
  (for example a small pytest plugin, written into the scratch folder, that prints one marked line per report and
  is parsed from pytest's piped stdout).
- `tests`, `ok: false`, only when there is no test at all (the text as today) or pytest could not run (its last lines).
- `live`: as today.

`ok` stays true only when every step passed. Tests (`test_analysis_trust.py`): stream order (start, form, transpile,
each case, live, done), a failing case's diff, a calculation's own pytest test named, a dictionary entry's cases,
non-stream output still one object.

### Mod

- **Never the pane in the app.** With `ASSAY_APP=1`, `/an trust` opens no pane (nor does anything else). `endReview`'s
  pane close goes.
- **Checks streamed.** `checkReview` runs the helper with `--stream` through `$.process.spawn` (with venv-assay's
  python, the cwd and timeout `helper` uses today; reuse `helper`'s python lookup and its venv-assay error), reads its
  lines, and keeps the review's `answer` up to date after each line. Outside the app the pane redraws after each line.
- **Trust file (app only).** With `ASSAY_APP=1` the mod writes `.assay/trust/<name>.json` atomically (temp file, then
  rename, like `runs.json`) when the review starts and after every line and state change:

  ```json
  { "name": "completes_by_site", "kind": "calculation" | "dictionary",
    "what": "SQL template" | "Python function" | "dictionary entry", "language": "sql" | "python" | "yaml",
    "replaces": false,
    "state": "checking" | "asking" | "approved" | "unchanged" | "rejected" | "failed" | "error",
    "startedAt": 1730000000000, "endedAt": 1730000004000,
    "description": "...", "code": "...",
    "steps": [{ "step": "test", "ok": false, "text": "FAILED ...", "name": "case 2", "diff": "..." }],
    "sample": { "columns": ["a"], "rows": [["1"]], "total": 12 },
    "message": "..." }
  ```

  `failed`: the checks ended and not every step passed (`message`: `Not approvable: fix the proposal, then /an trust
  <name> again.`). `error`: the helper or the commit failed (`message`: why). `approved` (`message`:
  `Trusted <name>: committed in trusted/.`), `unchanged` (`message`: `Already trusted: no changes.`), `rejected`
  (`message`: `Rejected <name>; the proposal stays in lib/trusted/.` or `lib/dictionaries/`). `endedAt`,
  `description`, `code`, `sample` and `message` are optional. A new `/an trust <name>` overwrites that name's file.
- **The approval is `$.ui.ask`**, asked by the mod once every check passed (in and out of the app):
  `$.ui.ask("Trust <name>?", { header: "Trust", options: ["Trust", "Reject"] })`. The state is `asking` while it is
  open. Only the exact answer `Trust` approves; `Reject`, any other text ("Other") and a rejection of the promise
  (dismissed) reject. When the checks fail, nothing is asked.
- **The pane's `y`/`r` card goes** (keys, buttons, the `/an trust` group in the `i` card). Outside the app the pane
  still shows the review (code, a line per step with each test's name, a failure's diff lines, the sample) and the
  state line: `checking… 4 s`, `Answer the question below.`, or the final message. Leaving it for a tab still drops
  the review from the pane, but not an open question.
- **One review at a time:** a `/an trust <name>` while a review is checking or asking answers
  `A review of <other> is in progress: answer it first.`
- **Nothing to commit:** after `git add`, `git diff --cached --quiet -- <paths>` exiting 0 means the files equal the
  trusted version. Do not commit; end as `unchanged` with `Already trusted: no changes.` (a toast outside the app too).
- **Command text:** in the app, `/an trust <name>` answers `Checking <name>: see the Trust tab in Assay. Answer the
  question here when the checks finish.`; outside it, as today minus the keys.
- **Tests** (`claude plugin test .`, fakes in `tests/fake.ts` for spawn lines and `$.ui.ask`): the trust file's states
  through a passing review (checking, asking, approved) and a failing one (failed, nothing asked); `Reject`, other text
  and a dismissal reject; unchanged files end `unchanged` with no commit; no pane opens with `ASSAY_APP=1`; a second
  review is refused while one is open; the pane draws without `y`/`r`.
- **Docs:** `README.md` (the Trust tab and the dialog replace `y`/`r`; `.assay/trust/`), `TRUST-HANDOFF.md` a short
  dated change entry.

### App

**Core.** New `core/trust.ts`: `parseTrustReview(text) -> TrustReview | undefined` (safe: unknown fields ignored, bad
steps dropped) and `latestReview(reviews)` (largest `startedAt`). `stepTitle(step)` gives `test case 2` / `transpile`.

**Main.** `loadState` reads `.assay/trust/*.json`; `AnalysisState` gains `trust?: TrustReview` (the latest). The poll
sees each rewrite.

**Renderer: Trust tab.** The data pane gains a fifth tab, `Trust`, shortcut **Cmd+Shift+R** (`tab.trust`, "Show Trust
tab"); the Show Shortcuts list and `PANE_KEYS` gain it.

- Shows the latest review: a header `Trust <name> · <what>` (`· replaces the trusted version` when it does), the
  description, the code (read-only CodeMirror, highlighted by `language`), then one line per step in pytest style:
  `PASSED` (green) / `FAILED` (red), the step title and its text; a failed test's diff below it in a monospace block
  (`-` lines red, `+` lines green); then `Live sample: 5 of 12 rows` and the table.
- The state line at the bottom: `checking… 4 s` (ticking), `Answer in the Claude pane (⌘1)` while `asking`, else the
  message (green for `approved` and `unchanged`, amber for `rejected` and `failed`, red for `error`).
- No review yet: `No review. Type /an trust <name> in Claude.`
- When a review with a new `startedAt` appears, the data pane switches to Trust once, without moving the keyboard
  focus (the user is typing in Claude). Like other tabs, Trust gets the unseen marker when its review changes while
  another tab is shown.
- Keys: `j`/`k` scroll, `g`/`G` top and bottom.

## Decisions recorded (from "Open for the build")

- **Note files show no trust label.** Each cited run's label shows beside its citation, derived at display time.
- **Claude creates a note file with a new `new_note` tool** that claims the number and checks the slug; it edits
  notes with `Edit`. The app creates notes itself (next number, `wx` write).
- **Links are by slug** (`[[slug]]`, or the whole stem); numbers are only for order. Note files are not listed in
  `notes.md`.
- **The trust review lives in the data pane's Trust tab** (the HANDOFF's "review view in the data pane"); approval is
  the mod's `$.ui.ask` dialog in the Claude pane, not `y`/`r`, in and out of the app.

## Not in this slice

The mod's pane showing note files. Link autocomplete, a note graph, renaming a note (and rewriting its backlinks).
Note files outside `notes/`.

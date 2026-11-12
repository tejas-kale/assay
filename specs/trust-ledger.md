# Trust ledger spec: only the app can approve (PI-1, PI-2, PI-8)

Status: Built 2026-11-12; not yet tried in the running app.

## Problem

Today three things decide what is trusted, and Claude's side can reach all three:

- **The answer.** The Trust tab's Trust button writes `trust-answer` into `.assay/requests/`; the server obeys any
  file there. Bash or the kernel can write that file (PI-1).
- **The record.** A calculation is trusted when it is committed unchanged in the root's git
  (`python/analysis_library.py` `file_state`). Bash or the kernel can copy a file into `trusted/` and commit it (PI-2).
- **The checks.** Check imports the proposal into the helper process, so the proposal can print its own `done`
  event with `ok: true` (PI-8).

The server, the kernel and Claude's Bash run as the same user in the same place, so nothing the server holds
(a secret, a review in memory) is out of Claude's reach. Trust must rest on something only the app writes.

## Decision

**Trusted means: these exact bytes were shown to the user in the app, and the user pressed Trust.** The app records
that in a ledger in its own data folder, which the launcher mounts read-only for Claude, like `ASSAY_BACKEND`.

```text
before                                   after
------------------------------------     ------------------------------------
Trust button -> request file -> server   Trust button -> IPC -> main
server copies + commits                  main writes the ledger; the server
                                         then copies + commits (if it backs)
trusted = committed in git               trusted = sha256 matches the ledger
Check result decides                     Check result is advice; the code
                                         shown is what gets approved
```

## The ledger

- One file per root: `<userData>/trust-ledger/<sha256 of the root's real path>.json`, written by main only, through a
  temp file and a rename.
- An entry per approved proposal, keyed `<kind>:<name>` so a calculation and a dictionary entry of one name never collide: `{ name, kind, files: { <root-relative path>: <sha256> }, approvedAt, commit }`; `commit` is empty (git history is the server's, and display only). A new
  approval of the same name replaces its entry; the previous one is kept under `history`.
- The app passes the file's path as `ASSAY_LEDGER` when it starts Claude (docs/developer/launch-contract.md). A launcher
  must mount it read-only. Without a launcher, Claude can write it: that is the isolation boundary's job, as for
  `ASSAY_BACKEND`, and docs/developer/security.md says so.

## Tickets

Each ticket is test-first and passes `npm run check` on its own.

1. **Ledger core and store** (half a day). Pure module in `src/core/trustLedger.ts`: parse, verify a file set against
   an entry, add an entry. Main store in `src/main/trustLedger.ts`: path per root, atomic write, refuse a ledger path
   that is a link. `ASSAY_LEDGER` added to the launch environment and the launch contract.
2. **Approval moves to main** (half a day). The Trust tab shows the proposal's files as main reads them from disk
   (not the code in the server's report), with their hashes. Trust sends IPC `trust:approve { name, hashes }`. Main
   re-reads the draft (regular files, no links, own basenames only), refuses if any hash differs from what was shown,
   and writes the ledger entry: the destination paths (`trusted/<file>` or `dictionaries/<file>`) with the approved
   hashes, `commit` empty. **Main writes only the ledger: it never runs git and never writes into the root**, which
   Claude's side can fill with hooks, git config and directory links (host code execution, redirected host writes).
   Main then sends `trust-done { name, outcome }`; the server, inside Claude's environment, reads `ASSAY_LEDGER`
   and, only if the ledger holds this proposal with exactly the draft's current hashes, copies the draft into
   `trusted/` or `dictionaries/` (own names, refusing links), commits it there for history and removes the draft;
   otherwise it answers "not approved in the app" and does nothing. A wrong copy is harmless: trust comes only from
   the ledger. Every Trust-tab call is bound to the root, analysis and ledger the window's session was launched with.
   `trust-answer` leaves the request channel (`src/core/requests.ts`, `src/server/requests.ts`).
3. **Readers check the ledger** (half a day). `analysis_library.file_state`, the `trusted` tool, trusted runs
   (`src/server/trustedRun.ts`), includes of trusted blocks and definitions, and the prompt hook's trusted context
   treat a file as trusted only when its sha256 matches the ledger. Git commit stays for display.
4. **Check is advice** (2 hours, PI-8). The proposal runs in a child process; only the parent helper prints events.
   The Trust tab labels the results "checked inside Claude's environment: approve the code you see".
5. **Adopt existing trusted files** (1 hour). After the update, files in `trusted/` and `dictionaries/` with no ledger
   entry show in the Trust tab as "not yet approved in this app", with one button to review and adopt them.

Out of this spec: forged `sql` / `python` request files still make a run look like the user's (the other half of
PI-1). The same idea fixes it later: main records which run numbers answered its own requests, and the app shows
authorship from that record instead of the header.

## Deferred

- **Helpers.** Approval covers a proposal's own files only, so a calculation can import a sibling in `trusted/` only
  when that sibling was approved as a calculation itself (`python/analysis_imports.py`). Letting a proposal list
  helper files for the Trust tab to show and the ledger to record waits until a calculation needs one (the user's
  choice, 2026-11-12).
- **Run authorship** (the other half of PI-1): see the note above and the PI-1 row in
  specs/audits/security-audit-2026-11.md.

## Done when

- A Bash or kernel write to `.assay/requests/`, `trusted/`, `dictionaries/` or the root's git cannot make anything
  trusted: tests for each in tickets 2 and 3.
- A proposal printing a `done` event cannot end its own Check: test in ticket 4.
- PI-1 (trust half), PI-2 and PI-8 move to Fixed in specs/audits/security-audit-2026-11.md; docs/developer/security.md
  describes the ledger and the launcher's new read-only mount.

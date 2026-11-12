# Rich conversation in Ghostty

Status: design agreed with the user on 2026-11-12 in a design interview. Not implemented. `ready-for-agent`.

## Problem Statement

Claude Code is where the user works, but what Claude did in a turn is scattered. The conversation hides tool output
behind ctrl+o, Claude's thinking is often redacted, and to see the SQL Claude ran, the rows it got back, the plot it
drew or the note it changed, the user hops between the Code, Data, Plots, History and Notes tabs. The tabs are not as
useful as the user wants: they pull attention away from the conversation, and they make it hard to follow Claude's
trail from one step to the next.

## Solution

The conversation itself becomes the rich view. The user runs Claude Code in Ghostty, started by a new `assay open
<slug>` command, with Assay's plugin loaded as usual. A Claude Code mod in Assay's plugin redraws each of Claude's tool
calls in place:

- `sql` and `python` show the full code, syntax highlighted, the first 10 rows of the result or the error, the plots
  as images, and the run number.
- `note` shows the note rendered as Markdown; `revise_note` shows its change as a coloured diff.
- Thread tools (`park`, `close`, `focus`, `order`) show one line each.
- Reads and Bash show one line each, expanded on demand.

Each rich row carries buttons: `[ full code ]` and `[ all rows ]` expand that row, `[ VisiData ]` copies a
`vd <run>.csv` command to the clipboard, `[ edit ]` opens the run's code in `$EDITOR` and on save sends it to the
server as a new run by the user, and `[ re-run ]` sends it again unchanged. ctrl+o still expands every row. The user
scrolls with Claude Code's fullscreen layout. Claude's thinking shows where the transcript holds it; otherwise the
text Claude wrote between tool calls stands in.

The Electron app stays as it is during the trial. The one rule holds unchanged: every run, Claude's or the user's,
goes through the server into a numbered, immutable run in `queries/`.

## User Stories

1. As an analyst, I want to start an analysis's Claude session from Ghostty with one command, so that I can work in my
   own terminal instead of the app.
2. As an analyst, I want `assay open <slug>` to start Claude with the same plugin, MCP server and environment the app
   would give it, so that the tools, hooks and skills behave exactly as in the app.
3. As an analyst, I want `assay open` to use my launcher (`ASSAY_CLAUDE_BIN`, the Podman wrapper) when one is set, so
   that Claude stays inside the isolation boundary I chose.
4. As an analyst, I want `assay open` to refuse an unknown slug and list the analyses it knows, so that a typo does not
   start a session in the wrong place.
5. As an analyst, I want `assay open` to tell me when Assay's backend or venv is not prepared yet, so that I know to
   open the app once or wait for the build.
6. As an analyst, I want `assay open` with no slug to list the analyses in my root, so that I can find the one I want.
7. As an analyst, I want each `sql` call to show the full SQL, highlighted, without pressing ctrl+o, so that I can read
   what Claude ran as it runs.
8. As an analyst, I want each `sql` call to show the first 10 rows of its result as an aligned table, so that I can
   judge the answer without opening the Data tab.
9. As an analyst, I want a failed `sql` or `python` call to show its error in place of the table, so that I see at once
   why Claude is retrying.
10. As an analyst, I want each `python` call to show the full code, highlighted, so that I can follow Claude's
    transformations.
11. As an analyst, I want each `python` call to show its tables' first rows and its printed output, so that I see what
    the code produced.
12. As an analyst, I want plots drawn as images in the conversation, so that I do not switch to the Plots tab.
13. As an analyst, I want each rich row to show its run number and whether it was Claude's or mine, so that I can cite
    and find the run later.
14. As an analyst, I want a row to say how many rows and columns the full result has, so that I know how much the
    10-row head leaves out.
15. As an analyst, I want a `[ full code ]` button on a row whose code is long, so that I can expand one query without
    expanding the whole conversation.
16. As an analyst, I want an `[ all rows ]` button on a row whose result is longer than 10 rows, so that I can see more
    of one table in place.
17. As an analyst, I want ctrl+o to keep expanding every row, so that the familiar key still works.
18. As an analyst, I want a `[ VisiData ]` button to copy `vd <path to the run's csv>` to my clipboard, so that I can
    paste it in a new Ghostty tab and sort, filter and count the full table.
19. As an analyst, I want an `[ edit ]` button that opens the run's code in my `$EDITOR`, so that I can change Claude's
    query myself.
20. As an analyst, I want saving and closing the editor to send the edited code to the server as a new run of mine,
    so that my edit is recorded like any other run.
21. As an analyst, I want closing the editor without changes to send nothing, so that an aborted edit leaves no run.
22. As an analyst, I want a `[ re-run ]` button that runs the code again unchanged as my run, so that I can refresh a
    result after the data changed.
23. As an analyst, I want my edited or re-run run to name the run it came from, so that History and lineage show where
    it started.
24. As an analyst, I want a row to say when its run is still running, so that I know the table is not final.
25. As an analyst, I want a row whose run files are missing or unreadable to fall back to Claude Code's own row, so that
    a broken run never hides the call.
26. As an analyst, I want `note` to show the new note rendered as Markdown, so that I read Claude's finding as written.
27. As an analyst, I want `revise_note` to show the change as a coloured diff, so that I see exactly what Claude
    altered in a finding.
28. As an analyst, I want `park`, `close`, `focus` and `order` to show one line each naming the thread, so that thread
    changes are visible but quiet.
29. As an analyst, I want `link_notes` and `note_labels` to show one line each, so that they do not crowd the turn.
30. As an analyst, I want Read, Grep, Glob and Bash calls to stay one line each, so that the analysis calls stand out.
31. As an analyst, I want to expand a Read or Bash row on demand, so that I can still check what Claude looked at.
32. As an analyst, I want Claude's thinking shown where the transcript holds it, so that I can follow its reasoning.
33. As an analyst, I want Claude's text between tool calls shown when thinking is redacted, so that every step still
    has its reason beside it.
34. As an analyst, I want the rich rows to scroll with the rest of the conversation, so that I can go back through a
    turn like an action replay.
35. As an analyst, I want the rows to fit my terminal's width, so that tables and code do not wrap into noise.
36. As an analyst, I want the colours to follow my light or dark theme, so that highlighting stays readable.
37. As an analyst, I want plots to fall back to their file name where the terminal cannot draw images, so that the row
    still tells me a plot exists.
38. As an analyst, I want the mod to load with every Assay session and with no other Claude session, so that my other
    Claude work is untouched.
39. As an analyst, I want the mod versioned and released with Assay, so that it always matches the server's run files.
40. As a developer of Assay, I want the row decisions in a pure core module, so that they are tested with the rest of
    the core and meet the coverage bar.
41. As a developer of Assay, I want the mod's own module thin and tested with `claude plugin test`, so that a broken
    hook is caught in `npm run check`.
42. As a developer of Assay, I want `assay open` to build its launch from the same function the app uses, so that the
    two launches never drift.
43. As a developer of Assay, I want edit and re-run to write the same request files the app writes, so that the server
    needs no new request kind.
44. As a security reviewer, I want no tool of Claude's able to press a row's buttons or write a request, so that Claude
    cannot pass its runs off as the user's beyond the accepted risk PI-1.
45. As a security reviewer, I want the mod to read only the open analysis's run files, so that it never shows another
    analysis's data.

## Implementation Decisions

- **Row model (new pure core module).** One function takes a tool call (tool name, input, the stored result text,
  whether it is running or errored) and, where the call made a run, that run's files as text (code, header, result,
  table CSVs, plot names), and returns a row model: a kind (`run`, `note`, `noteDiff`, `thread`, `quiet`, or `engine`
  to draw Claude Code's own row), the code and its language, the run number and author, a table head of at most 10
  rows with the full row and column counts, the error, plot file names, a note's Markdown or diff hunks, and the
  buttons the row offers. It reads no files: the mod reads them and hands in the text. It reuses the existing run,
  table and note parsers in the core.
- **Run number from a call.** The row model finds the run number in the `sql` or `python` tool's result text; when it
  cannot, the row falls back to the engine's own row.
- **Rich-row mod.** A Claude Code mod shipped in Assay's plugin, next to its hooks and skills, loading with every
  session the plugin loads in. Its module hooks `ui.render` on the `ToolUse` component for Assay's tools and for Read,
  Grep, Glob and Bash; it reads the open analysis's run files through the engine's file access, calls the row model,
  and draws the result with the surface's elements: `Code` with a language for SQL and Python, `Code` with the diff
  format for `revise_note`, `Markdown` for notes and the table head, `Image` for plots, and `Button`s. While the row
  is expanded (ctrl+o) it passes to the engine's own row first and adds its parts below. Per-row expansion state is a
  `$.state` value keyed by tool use id, declared in the mod's type contract.
- **Only the open analysis.** The mod resolves run files against `ASSAY_ANALYSIS` and refuses any path outside its
  `queries/`.
- **VisiData.** `[ VisiData ]` puts `vd '<absolute path of the run's table csv>'` on the clipboard through the
  surface's copy, and toasts that it did. Opening a Ghostty tab is out of scope.
- **Edit and re-run.** `[ edit ]` writes the run's code to a scratch file, starts `$EDITOR` on it through the engine's
  process access, and on a clean exit with changed text writes a `sql` or `python` request with `from` set to the
  source run, built by the existing request-text function and written as the app writes it (real folders checked, a
  no-follow exclusive create, a rename into place). `[ re-run ]` writes the same request with the code unchanged. The
  server already marks such runs `author: user`; no new request kind is added.
- **Who can press.** Only a person's press on a row reaches these actions; no tool Claude has can raise them. The mod
  registers no tool and no command.
- **`assay open` (new command line).** `assay open <slug>` resolves the root from the app's settings, checks the
  analysis exists, finds the prepared backend and venv for the installed version, builds the launch with the same
  spawn-spec function the app uses (environment, `--plugin-dir`, `--mcp-config`, the launcher when set) and replaces
  itself with Claude in the current terminal. With no slug it lists the analyses. It fails with a named reason when the
  root, analysis, backend or venv is missing. It is bundled with the app's backend and installed on PATH by
  `npm run install-app`.
- **Thinking.** The mod does not touch thinking blocks; it draws what the engine keeps.
- **Electron app.** Unchanged in this work. The earlier "action replay pane" design is dropped.

## Testing Decisions

- A good test drives a module through its public function and checks what a person would see or what reaches disk:
  the row model's output for a given call and run files, the request file written, the launch built. No test reaches
  into private helpers.
- **Row model:** node:test in the core, like the other core modules' tests. Cases: a SQL run with a long result
  (10-row head, counts), a failed run (error), a Python run with tables and plots, a running call, missing run files
  (engine row), `note`, `revise_note` (diff hunks), each thread tool, a quiet Read, and a result text with no run
  number.
- **Mod module:** `claude plugin test` mounting a `ToolUse` row on the terminal surface (and desktop, to show it does
  not depend on one), pressing each button, and checking the clipboard text, the expansion state and the request
  written. Added to `npm run check` and held to the coverage bar.
- **`assay open`:** node:test on the pure part (resolving the analysis and building the spawn spec), with prior art in
  the session module's tests; the exec is a thin shell.
- **Edit and re-run end to end:** a case in the backend integration test writing the request the mod writes and
  checking the new run is numbered, `author: user` and names its source run, as that test does for the app's
  requests.
- **Prior art:** the core's run, request and session tests; the integration harness's scratch root; `modModel.test.ts`,
  ported from an earlier analysis mod.

## Out of Scope

- Opening VisiData in a new Ghostty tab or window.
- A table viewer pane inside Claude Code.
- Changing or retiring the Electron app, its tabs or its terminal; image support in its built-in terminal.
- Recovering redacted thinking.
- A turn log, turn numbers on runs, or a replay pane.
- Trust review from Ghostty: the Trust tab's buttons stay the only way to start or answer one.

## Further Notes

- **Security review first.** The mod writes request files from inside Claude Code's process, which only the app does
  today. Read `docs/developer/security.md` before building, record the mod as a request writer under PI-1, and confirm
  that hooks still stop Claude writing into `.assay/`.
- **Spike first.** Confirm in Ghostty that `Image` draws plots, that highlighting suits the Ayu themes, and that a
  `ToolUse` hook sees the `mcp__assay__` result text the row model needs.
- An earlier analysis mod existed outside this repo; its model tests were ported into the core, and its pane was
  retired when the app took over. This work brings a mod back for the conversation alone.

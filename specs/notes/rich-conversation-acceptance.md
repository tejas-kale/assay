# Rich conversation: deferred live acceptance

> **2026-11-13:** the `assay` CLI and the edit and re-run buttons were removed; skip the steps that use them and run the rest in the app's terminal.

Automated tests mount the actual mod on terminal and desktop surfaces. They do not establish image drawing,
colour readability or live MCP delivery. On 2026-11-12 the user authorised implementing tickets 03–08 before
these live checks. Use an installed build containing this change and Claude Code 2.1.323 or later.

## Prepare a scratch analysis

1. Install the build with `npm run install-app` on the Mac.
2. Use a scratch root and scratch analysis in Assay; let its backend finish preparing. Do not test against real analyses.
3. Close the analysis's app session before `assay open <scratch-slug>` in Ghostty. Only one server/kernel may own it.
4. Confirm the session names the scratch analysis and exposes the Assay SQL/Python tools.

## Confirm live rows

1. Ask Claude to use Assay SQL on a harmless scratch query. Check highlighted SQL, run number/author, ten-row preview,
   full counts and errors. Verify the stored result reaches the rich row without ctrl+o.
2. Ask Claude to use Assay Python to print text, return tables and draw a PNG plot. Check K ordering, counts, stdout,
   error display and visible PNG drawing. Unsupported terminals should show the plot's filename.
3. Try note creation, text replacement, and thread changes. Check Markdown, coloured replacement excerpts and one-line summaries.
4. Use a query longer than 40 lines and a result longer than ten rows. Expand each separately; check other rows stay
   collapsed. Check Read/Grep/Glob/Bash details and ctrl+o, with the engine row first in the expanded view.
5. Repeat SQL/Python/diff readability under Ayu light and dark themes and at a narrow terminal width.

## Confirm buttons and recorded execution

1. Press each table's VisiData button, paste into a new Ghostty tab and check that spaces/apostrophes remain one path.
2. With an interactive `$EDITOR`, press edit. Save changed code; confirm a new immutable run with `author: user` and
   `from` naming the source. Close unchanged, or exit with failure; confirm no request/run is sent. Check the terminal redraws.
3. Press re-run; confirm the source is untouched and a new user run names it. Every execution must go through the server.
4. End the terminal session, open the scratch analysis in the app, and confirm the recorded runs in History.

## Known runtime limits to check

Plots use a checked PNG file source in an image box up to 255 columns by 20 terminal rows. Desktop and SVG plots
show filenames. Confirm the plot size is useful in Ghostty. Editor subprocesses have a ten-minute limit; very long
editing sessions should be saved and closed sooner. Per-row state survives module reload, for the session's lifetime.

Record observations against tickets 01 and 02. Leave their unchecked live criteria open until observed.

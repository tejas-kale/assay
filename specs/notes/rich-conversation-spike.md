# Rich conversation spike — 2026-11-12

## Outcome

The API needed for stored SQL results exists in installed Claude Code 2.1.322. A throwaway mod's
`claude plugin test` passed one test mounting the same `ToolUse` row on terminal and desktop surfaces.
The test supplied an MCP output containing `Run 42` and found the mod's rendered `Run 42` text on both.
This proves the render contract and parsing path with a supplied output, not that a live MCP session delivers
that exact output shape. The mounted test did not exercise Image or theme rendering; those contracts below come from documentation.
The spike registered only a `ui.render` hook, no tools or commands.

The throwaway code is not shipped. No live Ghostty trial was possible: `command -v ghostty` returned no path.
The image drawing, light/dark Ayu highlighting and live MCP output checks remain pending. Ticket 01 is not complete.

## Verified contracts and implementation consequences

- `ToolUse.props` has `tool_use_id`, `tool`, `input`, `isRunning`, `isErrored`, `isInterrupted`, and optional
  `output`. MCP results use content blocks, so read text blocks rather than assuming the output itself is a string.
  The published type declaration and installed test runner agree on this mounted shape.
- `Image` exists on terminal only; desktop rich rows must use a text fallback for plots. Unsupported terminals draw
  the image's `alt` text automatically. Use a meaningful plot filename as `alt`. Ghostty is documented as supported;
  actual drawing has not been observed here. iTerm2 and tmux require PNG/RGBA bytes instead of file paths.
- `ToolUse` has no `isExpanded` prop in the inspected declaration; `ToolGroup` does. Do not assume a nonexistent
  flag to implement ctrl+o. Preserve the engine's own row unless a runtime-verified expansion signal is available.
- `$.fs.stat(path, { resolve: true })` returns `realPath`; run reads must constrain the resolved destination to
  the open analysis's resolved `queries/`, not just compare input spelling.
- `$.fs.write` replaces in place and offers no exclusive-create or rename options. Edit/re-run must invoke a bundled
  process implementing the existing safe request writer, rather than treating `$.fs.write` as atomic.
- The documented mods API has no method to press a button. Surface input invokes callbacks, while a press helper is
  available in the test kit. This is a UI invocation constraint, not protection against arbitrary code forging request
  files (accepted PI-1). No callback may be registered as a tool or command.

## Checks

- `claude --version`: `2.1.322 (Claude Code)`.
- `claude plugin test` is present; mounted spike: 1 pass, 0 fail.
- `node --test src/hooks/decide.test.ts`: 17 tests pass, 0 fail (the suite also tests prompt state). The tests named
  "the analysis's .assay/ and queries/ and the root's git are Assay's alone, in any case", "a protected folder that is
  a symlink protects its name and its destination, existing or dangling", and "the other-analysis refusal names the
  open analysis by its folder, never by its title" cover the relevant file-edit refusals. The plugin still attaches the guard to Write/Edit/MultiEdit/NotebookEdit.
- Bash can still forge requests, within the accepted PI-1/L-1 gap; the file-edit guard is not an execution boundary.
- The full project gate must pass before commit; live Ghostty acceptance remains separate from the automated gate.

## Primary sources

Discovered with Kagi, then read directly as Markdown on 2026-11-12:

- [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference.md): module layout, `Image` surface,
  filesystem API and limits.
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create.md): installed-version declarations, module
  validation and test command.
- [Test a mod](https://code.claude.com/docs/en/plugins/mods/test.md): mounting supplied props and limits of painting tests.
- [Interface](https://code.claude.com/docs/en/plugins/mods/interface.md#respond-to-presses-and-typing): callbacks and
  absence of an API to press another mod's buttons.
- [Gallery](https://code.claude.com/docs/en/plugins/mods/gallery.md#image-and-client): Ghostty, alt fallback and
  iTerm2/tmux file-path restrictions.
- [Published declaration](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts):
  `RenderPropsOf.ToolUse`, `ToolGroup`, filesystem and test-kit press contracts. A live interactive load must still
  compare the declaration Claude writes for the installed build before relying on version-specific behavior.

## Implementation follow-up: installed Claude Code 2.1.323

Ghostty 1.4.0 is installed, but launching fails with `Gtk: Failed to open display`. The user deferred
live acceptance and authorised implementing the remaining tickets.

An empty interactive Claude session in a scratch directory generated the installed declaration without a model
call. Unlike the older published declaration, this build includes `ToolUse.isExpanded?: boolean`: true for ctrl+o,
verbose mode or expanded groups; absent where the surface does not report it. Rich rows can preserve the engine
row first when expanded and conservatively when the flag is absent. The installed declaration also confirms
`$.state.get/set`, `$.ui.copy({ text, surface })` returning `isCopied`, and `$.process.run` with captured streams.
Interactive editor stdio therefore needs a controlling terminal rather than the helper process’s JSON stdin.
These API observations do not establish image drawing or Ayu readability in Ghostty.

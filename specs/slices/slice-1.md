# Slice 1 spec: terminal, notes and threads

Implements "Build slices" item 1 of `HANDOFF.md`. Read `HANDOFF.md` first; it wins on product intent. This file fixes the
seams and the decisions the handoff left open.

## Constraints of the build environment

- Agents run in a Linux container: no Electron, no display, no npm registry, no `node_modules` until the user installs on
  the Mac. The project folder is shared with the Mac.
- Logic tests use Node's built-in runner and type stripping, so they run with no install:
  `node --test "src/**/*.test.ts"`. They must never import electron, node-pty, react or ghostty-web.
- Imports between TypeScript files use the `.ts` extension. Only erasable TypeScript syntax: no `enum`, no parameter
  properties, no `namespace`.
- `npx tsc --noEmit` works only after the user's install. Until then, nothing has been typechecked; say so in reports.
- The mod's source is readable at `/opt/analysis` (`hooks/model.ts`, `hooks/register.tsx`, `tests/model.test.ts`). The config
  repo is not otherwise visible and cannot be edited from this session.

## Stack

`electron-vite` + React + TypeScript. `"type": "module"` in `package.json`.

```
dependencies:    ghostty-web ^0.4.0, node-pty ^1.0.0, react ^19.1.0, react-dom ^19.1.0
devDependencies: electron ^37.0.0, electron-vite ^4.0.0, vite ^7.0.0, @vitejs/plugin-react ^5.0.0, typescript ^5.8.0,
                 @electron/rebuild ^4.0.0, @types/node ^22.0.0, @types/react ^19.0.0, @types/react-dom ^19.0.0
scripts:         dev (electron-vite dev), typecheck (tsc --noEmit), test (node --test "src/**/*.test.ts"),
                 postinstall (node scripts/postinstall.mjs)
```

- `scripts/postinstall.mjs`: does nothing unless `process.platform === 'darwin'`. On the Mac it runs
  `electron-rebuild -f -w node-pty`, then sets the execute bit on any `node_modules/node-pty/prebuilds/*/spawn-helper`.
- Main is ESM with node-pty external. Preload is built as CJS to `preload/index.cjs`, so the window can use
  `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- CSP in `index.html`: `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self'
  'unsafe-inline'; connect-src 'self' ws: data: blob:; img-src 'self' data:`.

## Layout of the code

```
src/core/       pure logic, no electron/react/node-pty; tested with node:test
src/shared/ipc.ts   the AppApi type and channel names, the only contract between main and renderer
src/main/       window, pty, file access, polling; thin over core
src/preload/    exposes AppApi as window.app
src/renderer/   React UI; thin over core
```

## Core modules (the seams to test at)

Behaviour that the mod defines must match the mod. Copy its logic and port its relevant test cases; do not invent a dialect.
Each module has `<name>.test.ts` beside it, written first.

**`core/threads.ts`**: `parseThreads(text)`, `formatThreads(threads)` as in the mod. Edits are pure functions over text that
take the item's current content and return new text, or throw `StaleEdit` when it no longer matches:
`addThread(text, thread)`, `editOpen(text, index, expected, next)`, `deleteOpen(text, index, expected)`,
`closeOpen(text, index, expected, outcome)`, `deleteClosed(text, index, expected)`, `moveOpen(text, index, expected, delta)`.

**`core/facts.ts`**: `parseNote`, `parseFileNote`, `notesFrom`, `notesText` as in the mod. `listFacts(text): Fact[]` where
`Fact = { index, line, text, label?, query?, file?: { title, path } }`. Edits: `addFact(text, input, queries)`,
`editFact(text, index, expectedLine, input, queries)`, `deleteFact(text, index, expectedLine)`, throwing `StaleEdit`.
Labels are always derived, never typed. A user's input may end with a tag such as `[q 12]` or `[trusted q 12]`:

- Only the cited query number is taken from the tag. The label in it is ignored.
- `queries` is the list of file names in `queries/`. Cited query with a `.csv` gives `queried`. No citation, or no `.csv`,
  gives `unverified`.
- The app never grants `trusted`, since only the mod knows a trusted run. Exception: an edit that keeps the same query on a
  line already labelled `trusted` keeps `trusted`, if the `.csv` still exists.
- An edit with no tag keeps the line's existing citation. A file-note line (`[Title](<path>)`) is not editable as a fact and
  throws; deleting it removes only the line.

Input with newlines collapses with `oneLine`. Empty input throws.

**`core/analyses.ts`**: what the mod's `/an` picker lists, read from `register.tsx`, with file access through an injected
port `{ readdir, stat, exists, mkdir, writeFile }`. `listAnalyses(port, root)` returns `{ name, path, modifiedMs }` newest
first. `validName(name)` follows the mod's rule. `createAnalysis(port, root, name)` makes `analyses/<name>/.analysis` and
nothing else, because the mod creates the other files on activation and never overwrites.

**`core/fuzzy.ts`**: `fuzzyRank(items, query, keyOf)`: case-insensitive subsequence match. Consecutive runs and word-start
matches rank higher, ties keep input order, an empty query returns the input unchanged.

**`core/keymap.ts`**: `COMMANDS`, a table of `{ id, title, accelerator?: KeySpec }` holding every action, used for both the
shortcuts and the palette. `commandForInput({ key, code, meta, shift, ctrl, alt })` returns the command id or undefined, and
is called from Electron's `before-input-event`, so a Cmd shortcut never reaches the terminal. It only claims the shortcuts in
the handoff's table; Cmd+C, Cmd+V, Cmd+A and every non-Cmd key are not claimed. Use `code` (for example `Digit1`) so layouts do
not matter. Commands: `focus.terminal`, `focus.notes`, `focus.data`, `palette.open`, `code.run`, `window.new`, `tab.data`,
`tab.plots`, `tab.code`, `tab.history`, `tab.notes`, `tab.threads`, `window.close` (Cmd+W), `pin.toggle`, `kernel.restart`,
`replay.open`. The last three show in the palette and report "not available until slice N" in this slice.

**`core/listNav.ts`**: a reducer for list panes. State `{ selected, search: { active, query } | undefined }`, keys `j`, `k`,
`g`, `G`, `/`, `Enter`, `Escape`, with the item count clamped. Returns state plus an optional effect `open`. Search filters
with `fuzzyRank`.

**`core/session.ts`**:

- `spawnSpec(folder, env)` returns `{ file, args, cwd, env }`. It runs the wrapper through the user's login, interactive
  shell, since a GUI app has a thin PATH: `file = env.SHELL ?? '/bin/zsh'`, `args = ['-lic', 'exec "${ASSAY_CLAUDE_BIN:-claude}"']`.
  It sets `ASSAY_APP=1`, `TERM=xterm-256color`, `COLORTERM=truecolor`, and removes `ELECTRON_RUN_AS_NODE`.
- `closeFlow(port)` with port `{ write(data), kill(signal), onExit(cb), setTimer(cb, ms) }` is the graceful close. Handoff item
  "Closing a window" says the wrapper must finish `agent_git_import` and release the forwarder, and must not be killed.
  It writes `\x03`, then `\x03` again after 300 ms: Claude Code's two-press exit. **It then writes nothing further**, because
  a later Ctrl-C could interrupt the wrapper's import. It exposes state `running | closing | exited`. `forceKill()` sends SIGHUP
  and is reached only from an explicit user confirmation. Exit from any state moves to `exited`.

**`core/watch.ts`**: `pollFiles(port, paths, onChange, intervalMs = 500)` with injected `stat` and timers. Fires on a change of
mtime, size or existence, which covers rename-over saves. Returns a stop function. Polling alone is the slice 1 decision: it
needs no answer to Verify first item 6, and costs two `stat` calls per tick.

## Main process

- One `BrowserWindow` per analysis. The window starts on the picker and becomes the workspace once an analysis is chosen.
  Cmd+N opens a new picker window. An analysis already open in a window focuses that window, since a second session in one
  folder would break "one Claude, one kernel".
- `webContents.on('before-input-event')` calls `commandForInput`; on a hit it calls `event.preventDefault()` and sends the id
  to the renderer. `window.new` is handled in main.
- Application menu: only the standard roles (app, Edit with copy/paste/selectAll, Window). No accelerators that duplicate the
  keymap, or they would fire twice.
- Window close and Cmd+Q: `close` is prevented while a session runs. The window stays visible, `closeFlow` starts and the
  renderer shows a "Closing: waiting for the session to finish" banner, with the terminal still visible. The window closes on
  pty exit. A second close during `closing` shows a native dialog offering "Keep waiting" (default) or "Force quit". Cmd+Q does
  this for each window, and the app quits when the last session has exited.
- A pty that exits by itself: the renderer shows "Session ended (exit N)". Cmd+W closes the window at once.
- Root folder: set in Settings (Cmd+,, or the palette) and saved to `settings.json` in Electron's user data folder. It must be an existing folder. There is no default and no environment override: with none set, the window shows Settings and cannot dismiss it.
- Writes to `notes.md` and `threads.md`: read fresh, apply the core function, write to a temp file in the same folder, rename.
  `StaleEdit` is returned to the renderer as "Changed on disk, reloaded" and the state is re-sent, not overwritten.
- A note file linked from `notes.md`: read only on request. Resolve its path against the analysis folder.

## Renderer

- RStudio grid as in the handoff. Left pane is the terminal; right top is Notes and Threads; right bottom shows the tabs Data,
  Plots, Code and History as named placeholders saying which slice brings them.
- `renderer/terminal.ts` is the only file importing `ghostty-web`, exposing `createTerminal(el) -> { write, onData, onResize, fit,
  focus, dispose }`. Handoff Verify item 1 may force a swap to `xterm.js`; it must be a one-file change. Fit by measuring cell size
  if the library offers no fit addon.
- The focused pane has a visible outline. Cmd+1, Cmd+2 and Cmd+3 move focus. Pane keys go through `listNav` and never run while
  the terminal, an input or a dialog has focus.
- Notes tab: one row per fact with its label as a coloured chip (`trusted`, `queried`, `unverified`, none). A file-note row opens
  its text read-only on Enter; Escape returns. Keys: `a` add, `e` edit, `d` then `y` delete. Editing is a one-line input; Enter saves,
  Escape cancels.
- Threads tab: Open and Closed sections. Keys: `a` add, `e` edit, `c` close with an outcome prompt, `d` then `y` delete, `J` and `K`
  move an open thread.
- Picker: a fuzzy input, always focused; the list shows name and age, Up/Down or Ctrl-N/Ctrl-P move, Enter opens. If nothing matches and
  the text is a valid name, Enter creates it, and the row says so.
- Long-pressing left Cmd for 500 ms shows subtle hints: a shortcut in each pane's corner and the global shortcuts at the bottom (`core/cmdHold.ts`). Releasing it, pressing any non-modifier key or losing focus hides them. There is no permanent shortcut bar; banners and toasts float at the bottom right.
- Palette (Cmd+P): `COMMANDS` through `fuzzyRank`, Enter runs, Escape closes and returns focus to the pane it came from.
- State comes from main over IPC after each poll hit. The renderer holds no copy that survives a reload.

## Decisions recorded (from "Open for the build" and gaps)

- Bundler is `electron-vite`, because `ghostty-web` is built with Vite and its `init()` takes no WASM path.
- File watching in slice 1 is polling at 500 ms.
- The app derives labels only conservatively, as in `core/facts.ts`; the mod re-derives on its own writes.

## Not in this slice

Request files, `session.json`, the kernel, the Data, Code and History contents, `notes/` Zettelkasten files, and CodeMirror.

## Config-repo change this slice needs

Pass `-e ASSAY_APP` in `claude/bin/claude`, and have the mod hide its pane when it is `1`. Until that lands the app still works,
with the mod's pane showing inside the terminal. See `docs/config-repo-slice-1.md`.

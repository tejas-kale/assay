# Assay

Electron desktop app over the analysis mod's folders: Claude Code in a terminal, plus Notes and Threads.
Slice 1 of `HANDOFF.md`; the spec is `docs/slice-1.md`.

## Install, run, test (on the Mac)

- `npm install` (postinstall repairs Electron's unpack on Node 26, rebuilds node-pty for Electron and fixes `spawn-helper`)
- `npm run dev`
- `npm test` (logic only, no install needed), `npm run typecheck` (never run yet; expect to fix some types)

## Install as an app (Spotlight, Dock, Launchpad)

- `npm run install-app` builds `Assay.app`, ad-hoc signed, and copies it to `/Applications`. Run it again after pulling changes.
- `npm run package` only builds it, into `dist/mac-arm64/`.

## Environment

- The analysis folder, which holds `analyses/`, is set in Settings (Cmd+,). There is no default: the app asks on first run. Picking `analyses/` or one analysis inside it sets the folder above.
- `ASSAY_CLAUDE_BIN`: the wrapper to run (default `claude`, found through your login shell)

## Appearance

The app follows the macOS light or dark setting live, using Ayu Light and Ayu Dark. All colours are in `src/core/theme.ts`.

## Verify first (do by hand, in this order)

1. ghostty-web with fullscreen mode: open an analysis, run a long Claude session. Look for correct drawing,
   mouse, text selection with Cmd+C, scrolling, and a clean redraw when you drag the window size.
2. Cmd shortcuts: press Cmd+1/2/3, Cmd+P, Cmd+N in the terminal while Claude is waiting. Look for focus moving
   with no stray characters in Claude's prompt, and Claude's own keys (Ctrl-C, Esc, arrows, Tab) still working.
3. node-pty: after `npm run dev`, the terminal shows Claude's prompt. If it shows "Could not start the session",
   run `npx electron-rebuild -f -w node-pty` and read the text.
4. Closing: with Claude running, press Cmd+W. Look for the "Closing: waiting for the session to finish" banner,
   then the window closing on its own once the wrapper's git import has finished. Press Cmd+W again during
   the wait: a Keep waiting / Force quit dialog appears. Repeat with Cmd+Q.
5. Starting from an analysis: pick one and look in the terminal for the wrapper finding `notes-src/.venv`,
   the mod activating, and the forwarder reporting `owner`.

## If the terminal fails

If ghostty-web's WASM fails to load, or its `new Terminal` API differs from the guesses, the fix belongs in
`src/renderer/terminal.ts` (its header lists every unverified assumption). It is the only file that imports
ghostty-web, so swapping to xterm.js is a one-file change.

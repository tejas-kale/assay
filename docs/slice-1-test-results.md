# Slice 1 test results

In progress. Run on the Mac on 2026-11-02, from `f6190d2`. Anything not listed yet is `NOT TESTED`.

"Claude" as observer means Claude ran the command and read the output, or read a screenshot captured from the window.

## Before Gate 1

| Check | Result | Observer | Evidence |
| --- | --- | --- | --- |
| `git log` shows `f6190d2` | PASS | Claude | After the user ended the sandbox session: `f6190d2 Fix slice 1 review findings`. The import landed in `refs/remotes/agent/*`, so `main` was pointed at it with `update-ref`. All 53 committed files had the same hash as the working tree. |

## Gate 1: install and static checks

| Check | Result | Observer | Evidence |
| --- | --- | --- | --- |
| `npm install` exits 0 | PASS, with a defect | Claude | Exit 0, but Electron's binary was not installed. See open failure 1. |
| postinstall rebuilt `node-pty` | PASS | Claude | `Building modules: node-pty`, `✔ Rebuild Complete`, `build/Release/pty.node` built. Whether it loads under Electron is tested in Gate 3. |
| `npm test` | PASS | Claude | `tests 73`, `pass 73`, `fail 0` |
| `npm run typecheck` | PASS | Claude | `tsc --noEmit` exit 0, no errors, no fixes needed. `terminal.ts` casts `ghostty-web` through `unknown`, so this says nothing about that API. |

## Gate 2: the app starts

| Check | Result | Observer | Evidence |
| --- | --- | --- | --- |
| Main builds | PASS | Claude | `out/main/index.js 30.43 kB`, `build the electron main process successfully` |
| Preload builds to `out/preload/index.cjs` | PASS | Claude | `out/preload/index.cjs 3.13 kB`; in the page `typeof window.app` is `object` |
| Renderer builds and loads | PASS | Claude | Dev server on `localhost:5173`; CDP target `Analysis`; the CSP meta tag is present |
| Window opens on the picker | PASS | Claude | Screenshot read over CDP: "Open an analysis" with the input focused. User: "The app looks good." |
| No main-process errors | PASS | Claude | The dev log has no errors after `start electron app...`. This also shows the `node-pty` default import resolves at load. |
| No DevTools errors | PASS | Claude | Over CDP: only `[vite]` debug messages and the React DevTools info line, no exceptions or log errors. |
| `will-navigate` handler signature | NOT TESTED | | No navigation has been triggered. |

## Changes the user asked for during testing

Synthetic input was fed to main's real `before-input-event` handler over the inspector, so the handler, timer, IPC and rendering are
exercised, but a physical key press is not. CDP key events do not reach that handler, and macOS refused `osascript` keystrokes.

| Check | Result | Observer | Evidence |
| --- | --- | --- | --- |
| First run with no root shows Settings, Escape cannot dismiss it, no picker | PASS | Claude | `{"dialog":"Settings","picker":false,"active":"settings-root"}`; `esc keeps it: true` |
| Settings refuses a relative or missing path | PASS | Claude | `Use a full path, starting with / or ~/.`; `No such folder: /Users/tejaskale/Code/does-not-exist-zz` |
| Saving `~/Code/zz-app-root` persists it and shows the picker | PASS | Claude | `settings.json` holds `"root": "/Users/tejaskale/Code/zz-app-root"`; the picker has focus |
| Cmd+, opens Settings, Escape closes it | PASS | Claude | Synthetic input; screenshot read |
| Cmd+P opens the palette, Escape closes it | PASS | Claude | Synthetic input: `dialog: Command palette`, `esc closes: true` |
| Cmd+K no longer claimed | PASS | Claude | Synthetic input: `cmd+k prevented: false`. Whether it sends anything to Claude belongs to Gate 4. |
| Left Cmd hold shows hints after 500 ms, release hides them | PASS, one miss | Claude | Synthetic input: nothing at 250 ms, `⌘P Palette ...` at 700 ms, gone on release. Passed in 3 of 4 runs; the miss was the first run, about 3 s after launch, cause not found. |
| Right Cmd shows no hints; a shortcut cancels them | PASS | Claude | Synthetic input: `right cmd: null`; `after cmd+p, hints: null` |
| Physical left Cmd long-press | NOT TESTED | | Needs the user. |
| Hints over the workspace panes | NOT TESTED | | Needs an open analysis. |
| Workspace has no bottom bar; banners float at the bottom right | NOT TESTED | | Needs an open analysis. |
| Settings Choose button | NOT TESTED | | Opens a native dialog. |

## Changes made

- At the user's request: removed the bottom bar; added left Cmd long-press hints; moved the palette from Cmd+K to Cmd+P; added Settings on Cmd+,.
- At the user's request: removed the `~/Code/notes-src` fallback. `ANALYSIS_ROOT` is gone too, so Settings is the only source.
- Created `~/Code/zz-app-root` and set it as the analysis folder, as the user chose. Gate 7 needs the real notes-src.

- `node_modules` only, not in the repo: extracted Electron from npm's cached zip with `ditto` and wrote `path.txt`. See open failure 1.
- The app was run as `npx electron-vite dev -- --remote-debugging-port=9222` so Claude can read the console and capture the window. No code changed.

## Open failures

1. **`npm install` silently leaves Electron broken on Node 26.** With Node v26.13.0, `node node_modules/electron/install.js` exits 0
   with no output, having extracted only about 300 KB and written no `path.txt`. `npx electron --version` then throws `Electron failed
   to install correctly`. The cached zip is fine: `unzip -t` reports no errors and its SHA-256 matches `checksums.json`. The likely cause
   is `extract-zip` 2.0.1 under Node 26, but that is not confirmed. Workaround used: `ditto -x -k <zip> node_modules/electron/dist`, then
   write `Electron.app/Contents/MacOS/Electron` to `path.txt`. A fresh install will hit this again.
2. **`~/Code/notes-src` does not exist on this Mac**, so the picker shows "No analyses yet" and Gate 7's default root has nothing to open.

# Handoff: test slice 1 of the analysis app on the Mac

You are Claude Code running on the user's Mac, in `~/Code/analysis-app`. Your job is to get slice 1 to run, test it, fix
what stops it from working, and report honestly. Do not build anything new.

## State

- Slice 1 was written in a Linux sandbox with no install, no Electron and no display. **The Electron, preload and React code
  has never been compiled, typechecked or run.** Only the 73 logic tests in `src/core` have run, and they passed.
- The last two commits are the build and the fixes from its code review. The fixes were not re-reviewed.
- Read these first, and do not restate them in your report:
  - `docs/slice-1.md`: the spec and decisions.
  - `HANDOFF.md`: product intent. Its "Verify first" list is why this test exists.
  - `README.md`: the by-hand checklist for Verify items 1 to 5.
  - `docs/config-repo-slice-1.md`: the mod change that is not done yet.
  - The header comment of `src/renderer/terminal.ts`: every unverified guess about `ghostty-web`.

## Rules

1. **Evidence only.** Mark a check `PASS` only if you ran it and saw the result, or the user told you what they saw. Quote the
   output or the user's words. If neither exists, mark it `NOT TESTED`. Never infer a pass from code reading or a clean build.
2. **Say who observed it.** You probably cannot see the Electron window. Do not claim to have seen anything on screen unless you
   have a screenshot you actually read. For anything visual or physical (rendering, Cmd keys, selection, scrolling), give the user
   one exact action and what to look for, then record their answer. Ask for one check at a time.
3. **Gates run in order.** Do not start a gate until the one before it passes. If a gate is stuck after three different attempts,
   stop, record the cause and what you tried, and ask the user.
4. **Fix only what blocks a check.** No slice 2 work, refactors, new dependencies or design changes. If the spec itself looks wrong,
   ask the user. A dependency version change is allowed only when a gate fails because of that version; record it.
5. **Do not weaken a check to pass it.** Do not delete tests, add `any` or `@ts-ignore` to silence an error, skip a check, or
   turn off `sandbox`, `contextIsolation` or the CSP without the user's approval. If the CSP blocks the WASM, make the smallest change
   and record it.
6. **`ghostty-web` fixes stay in `src/renderer/terminal.ts`.** Do not swap to `xterm.js` on your own: bring the evidence to the user and
   let them decide.
7. **Protect the user's data and sessions.**
   - Never kill the `claude` wrapper or its container outright, except by choosing Force quit when the check asks for it, and only in
     a throwaway analysis. A killed wrapper loses `agent_git_import`.
   - Test Notes and Threads edits only in a throwaway analysis named `zz-app-smoke`, never in a real one. Ask the user before
     deleting it.
   - Do not edit `~/Code/config` from this session. Do not push.
8. **Commits.** Small commits on the current branch, each naming the check it fixes. Stage specific paths. Add a logic test in
   `src/core` for any logic bug you fix there. `npm test` must pass before each commit.

## Before Gate 1

The sandbox's commits reach the Mac when that session ends. Run `git log --oneline -3`; it must show `f6190d2 Fix slice 1 review
findings`. If it does not, stop and ask the user to end the sandbox session. Do not copy files across by hand.

## Gates

Record each result in `docs/slice-1-test-results.md` as you go, and commit that file at the end.

**Gate 1: install and static checks.**
- `npm install` exits 0, and postinstall rebuilt `node-pty` for Electron.
- `npm test` shows 73 or more passing, 0 failing.
- `npm run typecheck` exits 0. This is the first typecheck the code has ever had, so expect errors. Fix them properly, including any
  type wrongly assumed for `ghostty-web` (see Rule 5).

**Gate 2: the app starts.**
- `npm run dev` builds main, preload (`out/preload/index.cjs`) and renderer, and a window opens on the picker. The user confirms.
- No errors in the main-process output or in DevTools. Unconfirmed guesses here: the default import of `node-pty` under ESM, the
  `.cjs` preload output from electron-vite 4, and the `will-navigate` handler signature.

**Gate 3: terminal (README items 3 and 1).**
- The user creates `zz-app-smoke` in the picker. Claude's prompt appears in the terminal, and typing reaches Claude.
- `init()` and the WASM load, the terminal fits its pane, and resizing the window redraws cleanly.
- Then the fullscreen checks, each a separate result: rendering, mouse, text selection with Cmd+C, Cmd+V paste, scrolling. Include a long
  session of at least 20 minutes of real use, as the handoff asks. Fullscreen issues are known risks of this class of terminal: record
  them exactly, do not hide them.

**Gate 4: keyboard (README item 2).**
- Each of Cmd+1, Cmd+2, Cmd+3, Cmd+P, Cmd+N and Cmd+W, and the Cmd+Shift tab keys, pressed while Claude is at its prompt: it acts, and no
  stray character reaches Claude. Each is its own result.
- Ctrl-C, Esc, arrows and Tab still reach Claude. Holding Cmd+N opens one window. Unconfirmed: whether `preventDefault` in
  `before-input-event` also stops menu accelerators from firing.

**Gate 5: notes, threads, picker, in `zz-app-smoke`.**
- Ask Claude in the app's terminal to add a note and park a thread. Both show in the tabs within a second or so, with no reload.
- Run `a`, `e`, `d` then `y` on a fact. Run `a`, `e`, `c`, `d` then `y`, `J`, `K` on threads. After each one, read the file on disk with your
  own tools and confirm it matches the mod's format. A fact typed with `[trusted q 1]` must not come out `trusted`.
- Keyboard-only: `j`, `k`, `/`, Enter, Escape. The Cmd+P palette runs a command and returns focus to the pane it came from.
- In the picker, Shift+Enter creates a new name that fuzzy-matches an existing one. Opening an analysis that is already open focuses its window.

**Gate 6: closing (README item 4). Run this last, in `zz-app-smoke`.**
- Cmd+W with Claude running: the banner shows, the terminal stays visible, the window closes by itself once the wrapper finishes.
- Confirm `agent_git_import` ran and the forwarder was released, using the wrapper's output and the port being free again. Do not assume it.
- Cmd+W during the wait: the dialog appears. Keep waiting works. If the session exits while the dialog is open, nothing crashes.
- Cmd+Q with two windows: each closes gracefully and then the app quits. Choosing Keep waiting cancels the quit, and a later window close
  does not quit the app.
- The closing sequence sends Ctrl-C twice and nothing after. **Test it while Claude is mid-turn as well as idle.** If mid-turn leaves Claude
  running, the window waits forever: record that as a failure and ask the user how they want it handled.

**Gate 7: starting from an analysis (README item 5).** The wrapper finds `notes-src/.venv`, the forwarder says `owner` and the mod activates.
Run this with the analysis folder set to the real notes-src, and ask the user before opening any real analysis.

## Known, not failures

- The mod's pane still shows inside the terminal, because `ANALYSIS_APP` is not passed through yet.
- The Data, Plots, Code and History tabs are placeholders.
- `pin.toggle`, `kernel.restart` and `replay.open` report that they arrive in a later slice.
- A renderer reload leaves the terminal blank, because main keeps no scrollback. The app menu has no reload. Record it only if it happens in
  normal use.
- HANDOFF Verify items 6 to 8 are out of scope: slice 1 polls files, and the other two belong to later slices.

## Finishing

1. `docs/slice-1-test-results.md` has one row per check: `PASS`, `FAIL` or `NOT TESTED`, who observed it, and the evidence. Separate
   sections list changes made and open failures.
2. Update "Status" in `HANDOFF.md` to what is actually true. Say "Slice 1 works" only if every check in Gates 1 to 7 passed.
3. Run `/code-review` on your own fixes, since the commit `f6190d2`, and resolve real findings.
4. Tell the user the counts of PASS, FAIL and NOT TESTED first, then the worst failure, then one next action.

The user has ADHD rules on: lead with the next action, numbered steps, one question at a time, concrete time estimates, no recaps.

## Suggested skills

- `run`: launch and drive the app.
- `diagnosing-bugs`: any failure that is not obvious on first look.
- `tdd`: any logic bug in `src/core`.
- `code-review`: at the end, as in Finishing step 3.

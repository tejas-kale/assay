# Multiple analyses in one window

Status: design agreed with the user on 2026-11-09 in a design interview. Not implemented.

## Problem

Today each window holds one analysis with its own Claude terminal (`attachAnalysis`, `src/main/windows.ts`); a
second analysis needs Cmd+N and a separate window. Three pains:

- You can't see which analysis has Claude working, waiting for you or idle without visiting each window.
- Switching between windows through macOS is slow.
- The user wants one window, not many.

## Design

1. **Model.** One window holds up to 9 analyses. Each keeps its own Claude terminal, kernel and runs. Hidden
   analyses keep running. Opening a 10th is refused with a prompt to close one.
2. **Switching.**
   - Cmd+1..9 switches analyses, numbered in the order they were opened. Closing one renumbers the rest.
   - Pane focus (terminal, notes and threads, data) moves from Cmd+1..3 to Ctrl+1..3.
   - Holding Cmd shows each analysis's number and title alongside the other Cmd hints. Holding Ctrl shows pane
     numbers.
3. **Strip.** A thin bar is always visible at the bottom, with one entry per analysis. Each entry shows the title
   (cut to 24 characters), Claude's state as an icon with no word (an empty circle for idle, a pulsing orange dot
   for working, a small white hand for waiting for you) and any run in progress with its duration. Changed after first use: the user keeps 3-4 analyses open, so titles always show
   rather than only on Cmd hold; Cmd hold adds the numbers. The
   palette's "Move analysis strip: bottom / left" moves it down the left side, as thin as the bottom strip with the
   text turned to read upwards, to compare; the choice is saved. A waiting analysis only gets a
   badge on the strip: no system notification, no dock bounce. This avoids pulling the user away from the current
   analysis.
4. **State kept on switch.** The full UI state of each analysis: active tabs, scroll positions, open code or editor,
   selected run, terminal scrollback and focus.
5. **Lifecycle.**
   - Cmd+N opens another analysis in the same window.
   - Cmd+W closes the current analysis and ends its Claude session, with today's confirmation if Claude is running.
     Closing the last analysis shows the picker.
   - Cmd+Q quits everything.
   - Relaunching reopens the same analyses in the same order, landing on the one last shown. Each gets a fresh
     Claude session; scrollback is not kept across quits.

## Implementation notes

- **Claude state.** Assay can't detect it today; it only knows whether the terminal process is running or has
  exited. Add Claude Code hooks to `plugin/hooks/hooks.json`: `UserPromptSubmit` means working, `Stop` means idle,
  and `Notification` means waiting for you.
- **Window model.** `attachAnalysis` refuses a second analysis per window. `WindowCtx` holds a single `analysis`
  and `session`; it needs a list of analyses per window, each with its own session, file watchers and reply polling.
- **Shortcuts.** All shortcuts are in `src/core/keymap.ts` (`COMMANDS`, `PANE_KEYS`). The Cmd-hold hints come from
  `src/core/cmdHold.ts`; Ctrl-hold needs a matching mechanism.
- **Check.** macOS can assign Ctrl+1..3 to "Switch to Desktop N" under Mission Control shortcuts. If enabled, those
  keys never reach Assay.
- **Invariant.** All analytical execution still goes through the recorded execution path. This change only affects
  how analyses are hosted and switched.

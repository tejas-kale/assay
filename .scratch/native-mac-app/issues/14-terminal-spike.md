# Spike: run Claude Code in SwiftTerm and GhosttyKit side by side

Type: prototype
Status: open
Blocked by: 01

## Question

HITL, on the Mac. Build two throwaway macOS apps, one hosting SwiftTerm and one hosting GhosttyKit, each launching `claude` through `$SHELL -lic`. Use them for a real session and compare:
- scrolling and redraw during long outputs
- the kitty keyboard protocol and the shortcuts Assay relies on
- mouse and selection
- light and dark themes
- CPU while idle and while streaming

Decide which terminal the hybrid uses. See [research/03-terminal-choice.md](../research/03-terminal-choice.md).

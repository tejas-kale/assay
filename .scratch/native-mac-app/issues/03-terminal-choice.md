# Which terminal component runs Claude Code in the native shell

Type: research
Status: resolved

## Question

Which terminal component should the hybrid use to run Claude Code's TUI: SwiftTerm 1.99.x, GhosttyKit (libghostty-spm), or libghostty-vt 1.0 with our own renderer? Compare them from primary sources on:
- PTY handling and process launch through the user's login shell
- rendering quality and speed with a full-screen TUI
- Kitty keyboard protocol, mouse and true colour
- themes, licence, and API stability

## Answer

Findings: [research/03-terminal-choice.md](../research/03-terminal-choice.md).

- **SwiftTerm** (MIT, pure Swift) fits the `$SHELL -lic` launch directly and supports what Claude Code uses: the kitty keyboard protocol, synchronised output, SGR mouse, true colour and OSC 8 links. Risks: 1.99.x is a preview before 2.0 with breaking changes still landing, and it is unproven with Claude Code (a December 2025 scroll bug, claude-code#14613, was closed without a fix).
- **GhosttyKit** gives Ghostty's own renderer for the least code, but it is the riskiest dependency: a single maintainer ships weekly patched builds of upstream's unreleased main branch, wrapping an API that upstream marks internal. It also always launches through `/usr/bin/login -flp`, not `$SHELL -lic`.
- **libghostty-vt 1.0** has a stable ABI but no PTY, renderer or text input, so it suits the fully native phase, not the hybrid.
- **No choice yet:** a spike on the Mac, running `claude` in SwiftTerm and GhosttyKit side by side, settles it. That spike is the next ticket.

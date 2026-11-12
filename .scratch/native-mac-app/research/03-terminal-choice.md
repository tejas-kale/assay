# Research: which terminal component runs Claude Code in the native shell

Ticket: [issues/03-terminal-choice.md](../issues/03-terminal-choice.md). Researched 12 November 2026.

## Method and sources

All three candidates were read at source. The repositories were cloned and read at these commits, and every link
below is pinned to one of them so it still says what it said today:

| Short name | Repository | Commit read | Latest release |
| --- | --- | --- | --- |
| `ST` | [migueldeicaza/SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) | `c86e1d8` (11 Nov 2026) | `v1.99.3`, 6 Nov 2026 |
| `GK` | [Lakr233/libghostty-spm](https://github.com/Lakr233/libghostty-spm) | `46e2378` (12 Nov 2026) | `2.2.2026110702`, 7 Nov 2026 |
| `GH` | [ghostty-org/ghostty](https://github.com/ghostty-org/ghostty) | `72ac7dc` (11 Nov 2026) | `vt-1.0.1`, 11 Nov 2026; app `v1.4.0`, 27 Oct 2026 |

Release dates come from the tag commit dates in the clones and, for SwiftTerm, from its
[releases page](https://github.com/migueldeicaza/SwiftTerm/releases).

**Gap:** ghostty.org, and so lib.ghostty.org, could not be reached from this session (DNS blocked by the session's
network policy). The libghostty-vt documentation was read from its Doxygen sources in the Ghostty repository
(`dist/doxygen/pages/`). These are the sources lib.ghostty.org is built from
([PACKAGING-LIBGHOSTTY.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/PACKAGING-LIBGHOSTTY.md)),
but the rendered site was not checked against them. Anything below that only ghostty.org could confirm is marked
**unconfirmed**.

Base URLs used below:

- `ST/` = `https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/`
- `GK/` = `https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/`
- `GH/` = `https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/`

### What the current app does (the baseline)

- Electron Assay runs Claude through node-pty and draws it with ghostty-web 0.4.0 (`package.json`,
  `src/main/session.ts`, `src/renderer/terminal.ts`).
- The launch contract says the app runs Claude "through the user's login, interactive shell (`$SHELL -lic`, so
  `claude` is found as a terminal finds it), in the root folder" (`docs/process/launch-contract.md`, line 9).
- `terminal.ts` and `src/core/terminalKeys.ts` work around several ghostty-web gaps, and the native choice should make
  each one go away:
  - colours are fixed at creation, so a live theme switch reaches into private fields;
  - rows are measured from "M", so descenders clip and line height has to be overridden;
  - Ctrl+V is taken as a browser paste, so `\x16` is sent by hand for Claude Code's image paste;
  - Cmd+letter is swallowed as the bare letter, so menu shortcuts are let through by hand;
  - Shift+Enter is rewritten to `ESC CR`.

## 1. SwiftTerm (1.99.x, heading for 2.0)

### What it is

- An MIT-licensed VT100/xterm emulator library for Swift with an AppKit `TerminalView` and a
  `LocalProcessTerminalView` that "connects the `TerminalView` to a Unix pseudo-terminal and runs a command there"
  ([ST/README.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/README.md),
  [ST/LICENSE](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/LICENSE)).
- Pure Swift. It began as a port of XtermSharp, which was based on xterm.js. It is used in shipping apps: Secure
  Shellfish, La Terminal, CodeEdit ([ST/README.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/README.md)).
- Package floor is macOS 11 (`.macOS(.v11)`,
  [ST/Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Package.swift)),
  so macOS 26 is no constraint.

### PTY and process launch

- `LocalProcess.startProcess(executable:args:environment:execName:currentDirectory:)` forks with `forkpty` and calls
  `execve`. The child resets signal dispositions and the signal mask before exec, and uses only async-signal-safe
  calls up to then
  ([ST/Sources/SwiftTerm/Pty.swift#L95-L139](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Pty.swift#L95-L139),
  [ST/Sources/SwiftTerm/LocalProcess.swift#L535-L556](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/LocalProcess.swift#L535-L556)).
- There is no login-shell logic. The host passes the executable and argv itself. `execName` sets `argv[0]`, so `-zsh`
  gives the classic login-shell marker
  ([ST/LocalProcess.swift#L536](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/LocalProcess.swift#L536)).
  Our existing contract, `$SHELL -lic "<cmd>"`, maps straight onto `startProcess(executable: shell, args: ["-lic", cmd],
  environment: …, currentDirectory: root)`. That mapping is my inference from the signature, not tested.
- A nil environment gets SwiftTerm's defaults with `TERM=xterm-256color`
  ([ST/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift#L475-L485](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift#L475-L485)).
  The Podman launcher's environment would be passed explicitly.
- The view can also be fed bytes from any source through `TerminalViewDelegate`. This is the way to go if the PTY
  should live elsewhere ([ST/README.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/README.md)).

### Rendering quality and speed

- The default renderer is CoreText/CoreGraphics. A Metal renderer is optional, off by default, and switched on with
  `setUseMetal(true)`. If the pipeline cannot be created it falls back to CoreGraphics
  ([ST/Sources/SwiftTerm/Documentation.docc/GPURendering.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Documentation.docc/GPURendering.md)).
- It has dedicated box-drawing, block-element and Powerline renderers and glyph fallback
  ([ST/Sources/SwiftTerm/Apple/](https://github.com/migueldeicaza/SwiftTerm/tree/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Apple)).
  Line spacing can be set (`_lineSpacing`), and row height comes from the cell dimension
  ([ST/Mac/MacTerminalView.swift#L483](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Mac/MacTerminalView.swift#L483)).
- Synchronised output (DEC mode 2026) is implemented, with a watchdog
  ([ST/Sources/SwiftTerm/DECPrivateModes.swift#L10-L11](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/DECPrivateModes.swift#L10-L11),
  [ST/Apple/SynchronizedOutputWatchdog.swift](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Apple/SynchronizedOutputWatchdog.swift)).
  Claude Code's flicker-free output depends on it.
- Conformance is checked against the esctest2 suite in CI. Tests have been taken from xterm.js and Ghostty
  ([ST/README.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/README.md)).
- Speed: SwiftTerm has headless vtebench ports, a RenderBench harness and opt-in Ghostty stream workloads. It says
  outright: "do not compare the absolute times with Ghostty's published times"
  ([ST/PERFORMANCE.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/PERFORMANCE.md)).
  The 1.99 series is mostly performance work: v1.99.0 notes that "2.0 is a major performance upgrade", and v1.99.3
  "improved every performance metric we have"
  ([releases](https://github.com/migueldeicaza/SwiftTerm/releases)). **No primary source gives a head-to-head
  figure against Ghostty.**
- Known Claude Code incident: [anthropics/claude-code#14613](https://github.com/anthropics/claude-code/issues/14613)
  (December 2025, Claude Code 2.0.71–2.0.73). The top region scrolled one line per update in SwiftTerm-based iOS
  apps (and in Termius) when an extra status row was showing. It was closed as stale, not planned, in February 2026,
  with no maintainer diagnosis. **Whether it still happens with SwiftTerm 1.99 and current Claude Code is
  unconfirmed.**

### Kitty keyboard, mouse, true colour

- The kitty keyboard protocol is implemented: all five flags (disambiguate, report events, alternates, all keys,
  text) and event types press, repeat and release
  ([ST/Sources/SwiftTerm/KittyKeyboardProtocol.swift](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/KittyKeyboardProtocol.swift),
  [KittyKeyboardEncoder.swift](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/KittyKeyboardEncoder.swift)).
- The view exposes `keyboardEnhancementFlags`
  ([ST/Documentation.docc/MigratingFrom1To2.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Documentation.docc/MigratingFrom1To2.md)).
  The macOS key router has a hook, `shouldSendCommandKeyToTerminal`, that decides whether Cmd goes to a kitty-mode
  program or to the menu
  ([ST/Mac/MacKeyboardRouter.swift#L111-L113](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Mac/MacKeyboardRouter.swift#L111-L113)).
  `optionAsMetaKey` defaults to `true`
  ([ST/Mac/MacTerminalView.swift#L2209](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Mac/MacTerminalView.swift#L2209)).
- Claude Code's docs say Shift+Enter works without setup in terminals that support the kitty keyboard protocol, from
  Claude Code v2.1.269 ([code.claude.com/docs/en/terminal-config](https://code.claude.com/docs/en/terminal-config)).
  So the `ESC CR` rewrite should not be needed. That follows from the docs; it has not been tested.
- Mouse: X10, VT200, button-event and any-event tracking, with X10, UTF-8 and SGR encodings
  ([ST/Sources/SwiftTerm/Terminal.swift#L942-L960](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Terminal.swift#L942-L960),
  [#L1064-L1080](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Terminal.swift#L1064-L1080)).
  Bracketed paste (2004) is listed in the DEC modes.
- True colour: "Supports colors (ANSI, 256, TrueColor)". Also OSC 8 hyperlinks, Sixel, iTerm2 and Kitty graphics
  ([ST/README.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/README.md)).
- It supports OSC 7501, the Program Status Protocol
  ([ST/Documentation.docc/ProgramStatus.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Documentation.docc/ProgramStatus.md)).
  Claude Code reports working, waiting and done through it from v2.1.295
  ([terminal-config](https://code.claude.com/docs/en/terminal-config)).
  This would give the app a session-status signal without parsing the screen.

### Themes, licence, API stability

- Themes: there is no theme catalogue. The host sets colours: `installColors(_:)` for the 16-colour palette, plus
  `nativeForegroundColor` and `nativeBackgroundColor`
  ([ST/Apple/AppleTerminalView.swift#L2548](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Apple/AppleTerminalView.swift#L2548),
  [ST/Mac/MacTerminalView.swift#L1357](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Mac/MacTerminalView.swift#L1357)).
  These are public setters, so a live light/dark switch needs no private access. That suits Assay, which owns its
  palette (`src/core/theme.ts`). Whether a palette change repaints existing cells at once is **unconfirmed**.
- Licence: MIT ([ST/LICENSE](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/LICENSE)).
- Stability:
  - 1.99.x is explicitly a "Preview before 2.0", and 1.20.0 was "one last release before we land the breaking
    changes" ([releases](https://github.com/migueldeicaza/SwiftTerm/releases)).
  - The README on `main` already documents the 2.0 API. The 1.x API lives on a `v1.x` branch
    ([ST/README.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/README.md)).
  - Known 2.0 breaks: the escape-sequence parser is internal (custom OSC goes through `registerOscHandler`), and
    `LocalProcess` and `HeadlessTerminal` initialisers gain `directDelivery`
    ([MigratingFrom1To2.md](https://github.com/migueldeicaza/SwiftTerm/blob/c86e1d85bc6c5f4bca0c7e1f14fa4d1f950c434d/Sources/SwiftTerm/Documentation.docc/MigratingFrom1To2.md)).
    v1.99.2 made `LocalProcessTerminalView.dataReceived(slice:)` unavailable.
  - **No 2.0.0 tag exists yet, and the date is unconfirmed.**
- Maintenance: one primary maintainer, Miguel de Icaza. He has 36 of the last 50 commits
  (`git shortlog` on a 50-commit shallow clone, so indicative only). Commits are frequent: the last one was 11 Nov
  2026.

## 2. GhosttyKit (Lakr233/libghostty-spm)

### What it is

- A Swift package that wraps a prebuilt, patched static `libghostty`. It ships as an XCFramework binary target and
  provides:
  - `GhosttyKit`, which re-exports `ghostty.h`;
  - `GhosttyTerminal`, with AppKit and SwiftUI views, input and display link;
  - `GhosttyTheme`, with 485 iTerm2-Color-Schemes themes;
  - `ShellCraftKit`.
- Sources: [GK/README.md](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md),
  [GK/Package.swift](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/Package.swift).
- Floor macOS 13. It requires Swift 6.2 and Xcode 26
  ([GK/Package.swift](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/Package.swift)).
- **The C API it wraps is not a public API.** Upstream's `ghostty.h` opens: "Ghostty's internal embedder API, a.k.a.
  'libghostty-internal'. The only consumer of this API is the macOS app … not designed for external use … External
  embedders should instead use `libghostty-vt`"
  ([GH/include/ghostty.h#L1-L11](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/include/ghostty.h#L1-L11)).
- The build carries 21 patches over upstream
  ([GK/Patches/ghostty](https://github.com/Lakr233/libghostty-spm/tree/46e2378824c3aeb2cc539d60e66247b54b97c38b/Patches/ghostty)).
  They cover host-managed I/O, iOS Metal fixes, an inspector stub, scroll remainder, "preserve sync on resize",
  "hold frame for prompt redraw" and others. The custom shader and inspector features are removed
  ([GK/README.md "Trimmed Build"](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md)).
- The same engine runs in a native Mac app aimed at Claude Code users: cmux describes itself as "a native Swift +
  AppKit app" that "uses libghostty as a library for terminal rendering" ([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)).
  Whether cmux uses this package or its own Ghostty fork is **unconfirmed**. The repo appears to pin a
  `manaflow-ai/ghostty` submodule.

### PTY and process launch

- There are two backends: `.exec` (the default), where Ghostty spawns and owns the PTY, and
  `.inMemory(InMemoryTerminalSession)`, where the host supplies bytes
  ([GK/Sources/GhosttyTerminal/InMemory/TerminalSessionBackend.swift](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/Sources/GhosttyTerminal/InMemory/TerminalSessionBackend.swift)).
  For `.exec`, `TerminalSurfaceOptions` has `command`, `workingDirectory`, `envVars` and `waitAfterCommand`. All are
  passed through `ghostty_surface_config_s`
  ([GK/Sources/GhosttyTerminal/Surface/TerminalSurfaceOptions.swift](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/Sources/GhosttyTerminal/Surface/TerminalSurfaceOptions.swift)).
- Upstream's exec path on macOS always goes through `/usr/bin/login -flp <user>` (with `-q` if `~/.hushlogin`
  exists). A shell-form command becomes `/bin/bash --noprofile --norc -c "exec -l <command>"`. A `direct:` command is
  handed to login's `execvp`
  ([GH/src/termio/Exec.zig#L1849-L1975](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/src/termio/Exec.zig#L1849-L1975);
  `direct:` in [GH/src/config/Config.zig#L1130-L1143](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/src/config/Config.zig#L1130-L1143)).
  - Consequence (my reading of that code): `command = "direct:/bin/zsh -lic <cmd>"` would give our `$SHELL -lic`
    behaviour, wrapped in `login(1)`. This is a second layer of login semantics we do not have today. It is **untested**.
- The package ships its own MIT bash and zsh shell integration (OSC 133, 7 and 2), and the `.exec` backend injects it
  as upstream does. Upstream's own scripts are GPLv3 and are not shipped
  ([GK/README.md](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md)).
  It also bundles the `xterm-ghostty` terminfo entry.

### Rendering quality and speed

- Ghostty's own Metal renderer with CoreText font discovery is kept in the trimmed build
  ([GK/README.md](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md),
  [GH/README.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/README.md)).
  This is the same renderer as Ghostty.app, the terminal the user already runs Claude Code in.
- Synchronised output (mode 2026) is in the core
  ([GH/src/terminal/modes.zig#L412](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/src/terminal/modes.zig#L412)).
- The package adds `resizeThrottleMilliseconds`. It is aimed at "a full-repaint TUI" during a live drag
  ([TerminalSurfaceOptions.swift](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/Sources/GhosttyTerminal/Surface/TerminalSurfaceOptions.swift)).
  Claude Code is exactly that.
- Speed: upstream calls its VT core's throughput "best-in-class"
  ([GH/dist/doxygen/pages/main.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/main.md)).
  That is the vendor's claim, and it covers the parser, not the renderer. **No independent benchmark against SwiftTerm
  was found.**

### Kitty keyboard, mouse, true colour

- All of these come from upstream Ghostty's input and terminal code: `src/input/kitty.zig`, `key_encode.zig` and
  `mouse_encode.zig` ([GH/src/input](https://github.com/ghostty-org/ghostty/tree/72ac7dced84e96a5d5214d005d59eadd10da27bb/src/input)).
  The upstream README lists the Kitty graphics protocol and synchronised rendering
  ([GH/README.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/README.md)).
  The package keeps the "Full keyboard/mouse/touch/IME pipeline"
  ([GK/README.md](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md)).
- Claude Code lists Ghostty as working without setup for Shift+Enter, and sends desktop notifications in Ghostty
  ([terminal-config](https://code.claude.com/docs/en/terminal-config)). Claude Code's detection presumably relies on
  `TERM`/`TERM_PROGRAM`, so whether an embedded surface gets the same treatment is **unconfirmed**.
- Links: on macOS, the default opener refuses every terminal link, including the OSC 8 links Claude Code prints. The
  host must set `onOpenURL` ([GK/README.md](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md)).

### Themes, licence, API stability

- Themes: Ghostty's full config system (including `theme = light:X,dark:Y`,
  [GH/src/config/Config.zig#L591](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/src/config/Config.zig#L591)),
  driven through `TerminalController`, plus the `GhosttyTheme` catalogue
  ([GK/README.md](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md)).
  Setting our own palette means generating a Ghostty config string. The README says a "theme or appearance change"
  is a config reload that keeps the surface ([TerminalSurfaceOptions.swift](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/Sources/GhosttyTerminal/Surface/TerminalSurfaceOptions.swift)).
- Licence: the package is MIT, as are libghostty and the themes; Ghostty's GPLv3 shell scripts are excluded
  ([GK/README.md](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md)).
- Stability: the weakest of the three.
  - A release lands every week, pinned to "upstream main's head of that Monday … a commit rather than a release".
  - Major.minor moves only for a breaking change to the package's own API.
  - The `1.4.0`–`1.4.13` and `1.5.0` tags "were withdrawn and no longer exist".
  - 2.0.0 removed `send`/`sendText` names.
  - Source: [GK/README.md "Versions"](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/README.md).
  - The engine underneath is upstream's unstable internal API, so every weekly bump can change behaviour.
  - At the commit read, `Ghostty.ref` names `cf5519b2…` but the binary target downloads `upstream.042b16b6146a`
    ([GK/Ghostty.ref](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/Ghostty.ref),
    [GK/Package.swift#L66-L69](https://github.com/Lakr233/libghostty-spm/blob/46e2378824c3aeb2cc539d60e66247b54b97c38b/Package.swift#L66-L69)).
    This is probably a ref bumped ahead of its release, but that is **unconfirmed**.
- Maintenance: essentially one person. Lakr/Lakr233 have 85 of the 131 commits reachable in the clone, with CI bot
  and a handful of contributors making up the rest. The issue tracker showed 0 open issues
  ([issues](https://github.com/Lakr233/libghostty-spm/issues)). The package is sponsored by AFK AI, Inc.
- Rebuilding from source needs Zig 0.17 and the patch stack (`build.sh`). That is a fallback if the maintainer stops,
  not a routine step.

## 3. libghostty-vt 1.0 with our own renderer

### What it is

- A portable, MIT, zero-dependency C library. "You give it the bytes a program writes, and it processes and exposes
  the state of the terminal" ([GH/dist/doxygen/pages/main.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/main.md)).
- Versioned separately with `vt-X.Y.Z` tags: 1.0.0 on 6 Nov 2026 ("the first stable release"), 1.0.1 on 11 Nov 2026
  ([GH/dist/doxygen/pages/release-notes.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/release-notes.md),
  [tag vt-1.0.1](https://github.com/ghostty-org/ghostty/tree/vt-1.0.1)).
- It is distributed as a signed XCFramework for Swift (`import GhosttyVt`), with an example package
  ([GH/dist/doxygen/pages/getting-started/installing.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/getting-started/installing.md),
  [GH/example/swift-vt-xcframework](https://github.com/ghostty-org/ghostty/tree/72ac7dced84e96a5d5214d005d59eadd10da27bb/example/swift-vt-xcframework),
  [PACKAGING-LIBGHOSTTY.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/PACKAGING-LIBGHOSTTY.md)).

### What it does not do

- It has no PTY, no process launch and no drawing. The hello example "has no GUI window and doesn't use a real PTY"
  ([main.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/main.md)).
  Replies the terminal owes the program (device attributes and the like) come back through effect callbacks for the
  host to write to the PTY ([GH/include/ghostty/vt.h](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/include/ghostty/vt.h),
  `c-vt-effects` example).
- So we would write all of the following, which SwiftTerm and GhosttyKit already provide:
  - `forkpty` and exec (SwiftTerm's `Pty.swift` shows the care this needs);
  - a CoreText and/or Metal renderer: glyph atlas, font fallback, box drawing, cursor, selection highlight;
  - `NSTextInputClient` for IME;
  - the mapping from `NSEvent` to key events;
  - scrolling, accessibility, and resize to the PTY.

### What it gives a renderer

- A render state: a copied frame with dirty tracking and row and cell iterators, colours and cursor. There is a
  two-phase update so the IO and render threads hold a lock briefly
  ([GH/dist/doxygen/pages/guides/rendering.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/guides/rendering.md)).
- Key and mouse encoders that follow the terminal's modes, including the Kitty keyboard protocol, SGR mouse, focus
  (1004), and paste framing (bracketed 2004 and Kitty 5522). There is a `MACOS_OPTION_AS_ALT` option
  ([GH/dist/doxygen/pages/guides/input.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/guides/input.md)).
- Selection, search, Kitty graphics, snapshots and a formatter are optional build features
  ([GH/dist/doxygen/pages/features.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/features.md)).
- Colours: default colours and the palette can be set, and OSC 10/11/4 overrides layer on top (`c-vt-colors`
  example, [vt.h](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/include/ghostty/vt.h)).
  Themes are therefore entirely ours.

### Rendering quality and speed

- Quality is whatever we build. Parser throughput is the vendor's "best-in-class" claim. The 1.0.1 notes give macOS
  ASCII throughput of 4,093 MB/s with a 1,000-line scrollback limit
  ([release-notes.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/release-notes.md)).
  These are vendor figures and do not cover rendering.

### Licence and API stability

- MIT ([main.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/main.md)).
- The strongest stability promise of the three: "A program built against one 1.x release keeps working with every
  later 1.x release. CI checks every change against these rules." Minor releases only add. The snapshot byte format
  is excluded ([GH/dist/doxygen/pages/stability.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/dist/doxygen/pages/stability.md)).
- Building from source needs a pinned Zig (0.17 for 1.0.0), but the prebuilt XCFramework avoids that
  ([PACKAGING-LIBGHOSTTY.md](https://github.com/ghostty-org/ghostty/blob/72ac7dced84e96a5d5214d005d59eadd10da27bb/PACKAGING-LIBGHOSTTY.md)).

## Side by side

| | SwiftTerm 1.99.x | GhosttyKit (libghostty-spm) | libghostty-vt 1.0 + own renderer |
| --- | --- | --- | --- |
| PTY / launch | `forkpty` + `execve`, host chooses argv; `$SHELL -lic` maps directly | Ghostty's exec: always via `/usr/bin/login -flp` on macOS; or host-managed bytes | None; we write it |
| Renderer | CoreText by default, optional Metal | Ghostty's Metal + CoreText (as Ghostty.app) | None; we write it |
| Sync output 2026 | Yes | Yes | Yes (state only) |
| Kitty keyboard | Yes, all flags; Cmd routing hook | Yes (upstream) | Encoder, yes |
| Mouse / true colour | Yes / yes | Yes / yes | Encoder / state, yes |
| OSC 7501 status | Yes | Not found in package docs (**unconfirmed**) | Not checked |
| Themes | Host sets palette (public API) | Ghostty config + 485 bundled themes | Entirely ours |
| Licence | MIT | MIT (wraps MIT libghostty) | MIT |
| API stability | Preview of 2.0; breaking changes landing; no 2.0 tag yet | Weekly releases on upstream `main`; wraps upstream's internal, unstable API; withdrawn tags in history | Stable C ABI across 1.x, CI-enforced |
| Maintainers | One main maintainer, active | One maintainer, active | Ghostty project |
| Our work | Small | Small, plus config translation | Large: renderer, IME, PTY, selection UI |

## Not confirmed, needs a spike on the Mac

1. How each candidate renders Claude Code today, in both its default and fullscreen (`/tui fullscreen`) modes,
   including a live resize. Nothing primary answers this. The SwiftTerm scroll-region incident (#14613) is the one
   data point, and it is a year old.
2. Whether Claude Code detects the embedded view as kitty-capable and sends notifications or OSC 7501 without
   `TERM_PROGRAM` tricks.
3. Whether a live palette change in SwiftTerm repaints existing cells.
4. Whether GhosttyKit's `login(1)` wrapping interacts badly with the Podman launcher or the environment the app passes.
5. Anything ghostty.org says that the repository docs do not (the site was unreachable).

## Implications for the decision

- **libghostty-vt 1.0 is the stable foundation, but not a terminal.** Choosing it means writing a Mac terminal
  front-end (renderer, IME, PTY, selection) before Assay gets a Claude pane. That conflicts with the hybrid's
  parity-first goal. It is better kept as the long-term option, or for the fully native phase.
- **GhosttyKit gives the closest match to what the user already sees in Ghostty, for the least code.** The cost is
  dependency risk. A single maintainer ships weekly builds of upstream `main`, through upstream's explicitly internal
  API and 21 patches. Pinning an exact version and reviewing each bump would be mandatory. Launch also goes through
  `login(1)`, unlike our `$SHELL -lic` contract.
- **SwiftTerm fits our launch contract and theme model most directly, and its feature set covers what Claude Code
  uses**: kitty keyboard, synchronised output, SGR mouse, true colour, OSC 8, and OSC 7501 as a bonus. It is pure
  Swift, so it is easiest for the user to read and debug. The risks are API churn until 2.0 is tagged (pin a 1.99.x
  or wait for 2.0) and rendering fidelity with Claude Code, which is unproven.
- In either embedding option, the Electron workarounds in `terminalKeys.ts` for Shift+Enter, Ctrl+V and Cmd letters
  should be unnecessary or reduce to a host hook, but this has to be checked.
- Suggested next step: a short spike on the user's Mac that runs `claude` in a SwiftTerm view and in a GhosttyKit
  view side by side, against items 1–4 above. Decide on what it shows, keeping libghostty-vt in the map as the
  fully-native-phase path.

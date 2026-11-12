# Research: how Claude builds, tests and drives a native Mac app

Ticket: [issues/05-agent-dev-loop.md](../issues/05-agent-dev-loop.md). Researched 2026-11-12.

The question: how can Claude Code develop the Swift hybrid the way `AGENTS.md` describes for Electron (build, unit
tests with coverage, driving the running app without a person, lint and format), and what works on Linux in a cloud
session versus what needs the Mac.

**Method.** Apple's developer documentation was read through its DocC JSON
(`developer.apple.com/tutorials/data/documentation/...`), which carries the same text as the pages linked below. Swift
tooling was read from its own repositories. Claims marked **[tested]** were checked in this cloud session by running
the official `swift:6.4` Docker image (Swift 6.4.2, Ubuntu, x86_64). Claims marked **[unconfirmed]** come from memory or
secondary sources and need checking on the Mac (usually with `man <tool>`).

**Network note.** From this session, `docs.swift.org`, `forums.swift.org`, `download.swift.org`, `llvm.org` and the
man-page mirror `keith.github.io` did not resolve, and GitHub Container Registry blobs were refused. The SwiftPM
reference was read from its source in the SwiftPM repository instead. The `xcodebuild`, `xccov` and `xcresulttool`
man pages could not be read, so their exact flags are marked unconfirmed.

## Where the tools stand today

- The current Xcode is 27.x: Xcode 27.2 is released and 27.3 is in beta. Both include Swift 6.4 and require a Mac
  running **macOS Tahoe 26.6 or later**.
  ([Xcode 27.2 notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_2-release-notes),
  [Xcode 27.3 notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_3-release-notes))
- The current Swift release is 6.4.2 ([swift.org/install/linux](https://www.swift.org/install/linux/)). **[tested]**
  `swift --version` in `swift:6.4` reports `Swift version 6.4.2 (swift-6.4.2-RELEASE)`.
- `xcodebuild`, `simctl` and `devicectl` ship only with the Xcode app, which must be set as the active developer
  directory ([Xcode command-line tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)).

## 1. Building from the command line

### xcodebuild (the app)

- `xcodebuild -list -project X.xcodeproj` lists targets, configurations and schemes. `xcodebuild -scheme S build`
  builds, and `build` is the default action
  ([TN2339](https://developer.apple.com/library/archive/technotes/tn2339/_index.html)).
- Tests run with `xcodebuild test -scheme S -destination 'platform=macOS,arch=…'`. For macOS both `platform` and
  `arch` are given. `-only-testing:Target[/Class[/Method]]` and `-skip-testing:` pick tests.
  `build-for-testing` writes an `.xctestrun` file, and `test-without-building` runs it
  ([TN2339](https://developer.apple.com/library/archive/technotes/tn2339/_index.html); the note dates from the
  Xcode 8 era, so its device names are stale).
- `xcodebuild test -scheme SampleApp` runs the scheme's default test plan. It writes an `.xcresult` bundle holding
  results, code coverage when enabled, and logs
  ([Running tests and interpreting results](https://developer.apple.com/documentation/xcode/running-tests-and-interpreting-results)).
- `xcresulttool` reads result bundles (`man xcresulttool`)
  ([command-line tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)).
- For CI: commit `Package.resolved` and pass `-disableAutomaticPackageResolution`. Pass `-scmProvider system` to
  use the Mac's own Git configuration
  ([Building Swift packages … in CI](https://developer.apple.com/documentation/xcode/building-swift-packages-or-apps-that-use-them-in-continuous-integration-workflows)).
- `-enableCodeCoverage YES|NO` and `-resultBundlePath <path>.xcresult` exist, but the man page could not be read here.
  **[unconfirmed]**: check with `man xcodebuild`.

### Project files an agent can edit

This was the classic pain point for agents: hand-editing `project.pbxproj`. Two first-party answers now exist.

- **`xcrun xcodeproj`** edits build settings (`setting get/set/list`), targets (`target add/remove/info`), build
  phases, groups and files (`group add-file`), and package dependencies (`pkg add/add-local/link`)
  ([Managing Xcode projects using command-line tools](https://developer.apple.com/documentation/xcode/managing-xcode-projects-using-the-command-line)).
- **The `.xcproj` JSON project format** is the default from Xcode 27.2. Apple calls it "more readable,
  merge-friendly, and easier for coding agents to edit". It works in Xcode 27 and later only
  ([Xcode 27.2 notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_2-release-notes),
  [Updating your Xcode project configuration file format](https://developer.apple.com/documentation/xcode/updating-your-xcode-project-configuration-file-format)).
- Apple publishes an open-source Swift library for the format, `apple/xcode-project-format`, with a
  `xcprojformatter` command. It needs Swift 6.1 or later and "also builds on non-Darwin platforms"
  ([README](https://github.com/apple/xcode-project-format)). So a Linux session could read and check the project
  file, though it could not build it.

### SwiftPM

- A Swift package uses `Package.swift` and its folder layout, with no `.xcodeproj`. Xcode can open, build and test a
  package directly
  ([Creating a standalone Swift package with Xcode](https://developer.apple.com/documentation/xcode/creating-a-standalone-swift-package-with-xcode)).
- SwiftPM's products are executables, libraries and plugins. The SwiftPM reference names no `.app` bundle, signing or
  entitlements step. **[unconfirmed, inference]**: a signed `.app` with an Info.plist, entitlements and web resources
  needs an Xcode app target, while the pure logic can live in a local package that the app target links.
- `swift test` options include `--filter`, `--skip`, `--parallel`, `--enable-xctest/--disable-xctest`,
  `--enable-swift-testing/--disable-swift-testing`, `--xunit-output`, and coverage (section 3)
  ([SwiftTest.md in SwiftPM](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/PackageManagerDocs/Documentation.docc/SwiftTest.md);
  this is the `main` branch, so a flag or two may be newer than 6.4).

### Xcode's own MCP server

- Since Xcode 26.3, Xcode exposes its capabilities to outside agents through MCP. The documented setup is
  `claude mcp add --transport stdio xcode -- xcrun mcpbridge`. It needs "Allow External Agents to Use Xcode Tools"
  turned on in Settings > Intelligence, and the project open in Xcode
  ([Giving external agents access to Xcode](https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode),
  [Xcode 26.3 notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26_3-release-notes)).
- Xcode 26.3 also added a permissions system for outside agents. A known issue: denying Claude access to a project in
  Desktop, Downloads or Documents cannot be undone from Xcode, so keep projects outside those folders
  ([Xcode 26.3 notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26_3-release-notes)).
- One tool, `RenderPreview`, is named in Apple's notes. In 27.3 it gained "interactive delayed snapshots for macOS
  previews" ([Xcode 27.3 notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_3-release-notes)).
  **[unconfirmed, secondary]**: third-party write-ups list about 20 tools (BuildProject, GetBuildLog, RunAllTests,
  RunSomeTests, GetTestList, XcodeRead/Write/Grep, ExecuteSnippet and others)
  ([Axiom reference](https://charleswiltgen.github.io/Axiom/reference/xcode-mcp-ref)). Apple's documentation found
  here does not list them.
- Xcode also runs Claude inside its own coding assistant ("Claude Agent"). Agents configured there use
  `~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig` and do not affect Claude Code in Terminal
  ([Extending and customizing agents](https://developer.apple.com/documentation/xcode/extending-and-customizing-agents),
  [Setting up coding intelligence](https://developer.apple.com/documentation/xcode/setting-up-coding-intelligence)).

## 2. Unit tests: Swift Testing and XCTest

- Swift Testing comes with the Swift 6 toolchain and Xcode 16, so it needs no package dependency. It is supported,
  with automated qualification, on Apple platforms, Linux, FreeBSD and Windows. XCTest tests can run side by side with
  it ([swift-testing README](https://github.com/swiftlang/swift-testing)).
- Apple's guidance: use Swift Testing for new unit tests. One target can hold both frameworks, but "don't mix API from
  the two frameworks in the same test". "Continue to use XCTest for user interface tests and performance tests"
  ([XCTest](https://developer.apple.com/documentation/xctest), [Testing](https://developer.apple.com/documentation/xcode/testing)).
  **Change in Xcode 27.3 beta:** "Xcode now supports writing UI tests with Swift Testing and `XCUIAutomation`"
  ([Xcode 27.3 notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_3-release-notes)).
- Swift Testing runs tests in parallel by default, in one process. `.serialized` opts a suite out, and `--no-parallel`
  turns it off globally ([Running tests serially or in parallel](https://developer.apple.com/documentation/testing/parallelization)).
- Test plans choose tests by target and by Swift Testing tags, and set coverage per configuration
  ([Organizing tests into test plans](https://developer.apple.com/documentation/xcode/organizing-tests-to-improve-feedback)).
- On Linux, `swift-corelibs-xctest` provides "the majority of unit testing APIs" of Xcode's XCTest, and `swift test`
  runs it ([README](https://github.com/swiftlang/swift-corelibs-xctest)).
- **[tested]** In `swift:6.4` on Linux, one test file with a Swift Testing `@Test` and an `XCTestCase` ran both under a
  single `swift test`.

## 3. Coverage

- SwiftPM: `swift test --enable-coverage` (formerly `--enable-code-coverage`, now deprecated). `--coverage-format json|html`
  runs `llvm-cov export` or `llvm-cov show`. `--show-coverage-path` prints where the report went. `-Xcov` passes flags
  through to the coverage tool
  ([SwiftTest.md](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/PackageManagerDocs/Documentation.docc/SwiftTest.md)).
- **[tested]** On Linux with Swift 6.4.2, `swift test --enable-code-coverage` wrote
  `.build/out/Products/Debug-linux-x86_64/codecov/Probe.json`. That is `llvm-cov export` JSON, with line, function and
  region summaries per file, merging the XCTest and Swift Testing runs. A file with one untested function reported
  lines 5/6 (83.3%) and functions 1/2. The JSON also lists test files and a generated `test_anchor.swift`, so a gate
  must filter by path. Note the build directory is `.build/out/...` in 6.4, not the older `.build/debug/...`.
  `llvm-cov` is on the image at `/usr/bin/llvm-cov`.
- Xcode: coverage is a test-plan option ("Gather coverage for", per target). The report counts tests that run with
  known issues and leaves out skipped ones
  ([Determining how much code your tests cover](https://developer.apple.com/documentation/xcode/determining-how-much-code-your-tests-cover)).
  Coverage lands in the `.xcresult`
  ([Running tests](https://developer.apple.com/documentation/xcode/running-tests-and-interpreting-results)).
  **[unconfirmed]**: `xcrun xccov view --report --json <bundle>.xcresult` turns it into per-target and per-file JSON
  that a script can gate on (check `man xccov`).
- UI tests can collect coverage too ("whether unit tests or UI tests")
  ([coverage doc](https://developer.apple.com/documentation/xcode/determining-how-much-code-your-tests-cover)).

## 4. Driving the running app without a person

Today's Electron loop (`AGENTS.md`): start the dev app with a stub `ASSAY_CLAUDE_BIN` and a scratch `userData`, drive
the renderer over CDP, send Cmd shortcuts through the main inspector, and read screenshots. There is no single
CDP-like port into a native app, but each part has a counterpart.

### XCUIAutomation (UI tests)

- XCUIAutomation (the UI-testing API, documented separately since Xcode 16.3) "control[s] your app's user interface
  and inspect[s] its state". It covers element queries, `XCUIApplication`, screenshots (`XCUIScreen`,
  `XCUIScreenshot`) and device simulation ([XCUIAutomation](https://developer.apple.com/documentation/xcuiautomation)).
- `XCUIApplication` launches, monitors and ends the app under test
  ([XCUIApplication](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication)). Its
  `launchArguments` and `launchEnvironment` are set by the test
  ([launchEnvironment](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/launchenvironment),
  [launchArguments](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/launcharguments)).
  That is where the `ASSAY_CLAUDE_BIN` stub and a scratch root go.
- The scratch-settings rule carries over cleanly. Launch arguments of the form `-key value` land in UserDefaults'
  volatile argument domain, which "override[s] most other domains, including your app-specific settings" and resets
  on each launch ([argumentDomain](https://developer.apple.com/documentation/foundation/userdefaults/argumentdomain)).
  A UI test can point the app at a scratch analysis without touching the user's real settings, provided the app keeps
  its root in UserDefaults or reads an override.
- Elements: `XCUIElement` offers `click()`, `rightClick()`, `hover()`, `scroll(byDeltaX:deltaY:)`, `typeText(_:)`,
  `typeKey(_:modifierFlags:)`, `perform(withKeyModifiers:)`, `waitForExistence(timeout:)` and `debugDescription`
  (the tree of descendants, for debugging only)
  ([XCUIElement](https://developer.apple.com/documentation/xcuiautomation/xcuielement),
  [debugDescription](https://developer.apple.com/documentation/xcuiautomation/xcuielement/debugdescription)).
  `typeKey` with `.command` sends Cmd shortcuts. This removes the Electron workaround of sending them through the main
  inspector **[unconfirmed]**: that menu shortcuts arrive through `typeKey` was not tested here.
- Stable selectors come from `accessibilityIdentifier(_:)` in SwiftUI: "Use this value for testing. It isn't visible
  to the user" ([accessibilityIdentifier](https://developer.apple.com/documentation/swiftui/view/accessibilityidentifier(_:))).
  Web content is reachable as a `webViews` query
  ([webViews](https://developer.apple.com/documentation/xcuiautomation/xcuielementtypequeryprovider/webviews)).
- Screenshots: `XCUIScreen.main.screenshot()` or `app.windows.firstMatch.screenshot()`, attached to the result with
  `XCTAttachment(screenshot:)` ([XCUIScreenshot](https://developer.apple.com/documentation/xcuiautomation/xcuiscreenshot)).
  Claude then pulls them out of the `.xcresult` (with `xcresulttool`; **[unconfirmed]**: the exact subcommand) and
  reads them as images.
- Permission: the first UI recording asks to grant **Xcode Helper** Accessibility access in Privacy settings
  ([Recording UI automation](https://developer.apple.com/documentation/xcuiautomation/recording-ui-automation-for-testing)).
  **[unconfirmed]**: whether `xcodebuild test` from Claude's Terminal triggers the same one-time grant. This needs a
  person once per Mac, and is the only step in the loop that does.
- Shape of the loop: UI tests are a scripted, compile-and-run cycle (`xcodebuild test -only-testing:AssayUITests/…`),
  not an interactive REPL like `Runtime.evaluate`. For "poke and look", Claude writes or edits a short UI test, runs it
  and reads the screenshots. **[unconfirmed]**: each cycle costs a build plus an app launch, likely tens of seconds.

### The accessibility API directly

- Assistive apps use the AXUIElement functions "to communicate with and control accessible applications running in
  macOS" ([AXUIElement.h](https://developer.apple.com/documentation/applicationservices/axuielement_h)). The calling
  process must be a trusted accessibility client. `AXIsProcessTrustedWithOptions` checks this and can prompt the user
  ([AXIsProcessTrustedWithOptions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions)).
  A small helper CLI could give an interactive "query the tree, press this, read that" loop against the running dev
  build, closer to CDP than UI tests. It needs the Terminal (or helper) granted Accessibility once. **[unconfirmed]**:
  no first-party command-line tool for this was found. Accessibility Inspector is a GUI tool
  ([Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector)).

### A debug channel the app owns (design option)

- The app can take its own screenshots without screen-recording permission. `NSView.cacheDisplay(in:to:)` draws a
  view tree into a bitmap ([cacheDisplay](https://developer.apple.com/documentation/appkit/nsview/cachedisplay(in:to:))),
  SwiftUI's `ImageRenderer` renders views to images ([ImageRenderer](https://developer.apple.com/documentation/swiftui/imagerenderer)),
  and `WKWebView.takeSnapshot(with:)` captures web content
  ([takeSnapshot](https://developer.apple.com/documentation/webkit/wkwebview/takesnapshot(with:completionhandler:))).
  ScreenCaptureKit, by contrast, needs the user's screen-recording permission
  ([ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)).
- The web views (CodeMirror, Mermaid) can be scripted from Swift with `evaluateJavaScript`
  ([evaluateJavaScript](https://developer.apple.com/documentation/webkit/wkwebview/evaluatejavascript(_:completionhandler:))).
  Setting `isInspectable = true` lets Safari Web Inspector attach (macOS 13.3+)
  ([isInspectable](https://developer.apple.com/documentation/webkit/wkwebview/isinspectable)). Inspector is a manual
  GUI, not a CDP port.
- **Inference:** Assay already talks through files (`.assay/requests/` → `.assay/replies/`). A debug-build-only
  request type (`ui-snapshot`, `ui-press <identifier>`, `ui-eval <js>`) answered by the app would give Claude an
  interactive driver with no TCC prompts. The cost: test-only code in the app, kept out of release builds.

## 5. Lint and format

### swift-format

- Bundled with the toolchain since Swift 6 (Xcode 16). Run it as `swift format`, and `xcrun --find swift-format`
  locates it in Xcode. `format -i` rewrites files in place (no backup). `lint` prints diagnostics, and
  `lint --strict` makes warnings fail the exit code. The config is a JSON `.swift-format` file found by walking up
  from each source file. `dump-configuration` prints the defaults
  ([swift-format README](https://github.com/swiftlang/swift-format)).
- Its version tracks the toolchain's SwiftSyntax, so the Mac (Xcode 27, Swift 6.4) and a Linux 6.4 toolchain format
  the same way when both are on 6.4 ([README](https://github.com/swiftlang/swift-format)).
- **[tested]** `swift format lint --strict -r Sources Tests` ran in `swift:6.4` on Linux. It reported indentation and
  semicolon violations and exited 1.

### SwiftLint

- Rules are set in `.swiftlint.yml` (`disabled_rules`, `opt_in_rules`, `only_rules`, `analyzer_rules`, `strict`,
  `included/excluded`). `--strict` treats warnings as errors. Rules can be switched off inline with
  `// swiftlint:disable` (which the project rule "never by disabling a rule" would forbid)
  ([SwiftLint README](https://github.com/realm/SwiftLint)).
- `swiftlint analyze` (type-aware rules) needs a compiler log from a clean `xcodebuild`, so it needs the Mac
  ([README](https://github.com/realm/SwiftLint)).
- Install: Homebrew, the SwiftLintPlugins SwiftPM build or command plugin, a Docker image, or release binaries. On
  Linux it needs `libsourcekitdInProc.so` in `/usr/lib` or `LINUX_SOURCEKIT_LIB_PATH`
  ([README](https://github.com/realm/SwiftLint)). Release 0.65.1 (the latest) ships `swiftlint_linux_amd64.zip` and
  `swiftlint_linux_arm64.zip` ([release assets](https://github.com/realm/SwiftLint/releases/expanded_assets/0.65.1)).
- **[tested, partly]** The `swift:6.4` image has `/usr/lib/libsourcekitdInProc.so` and `sourcekit-lsp`. The Linux
  binary downloaded from GitHub releases, but running it was not done in this session. The GHCR Docker image could not
  be pulled through this session's proxy. **[unconfirmed]**: SwiftLint running on Linux here.
- Overlap: swift-format and SwiftLint both have style rules. If both are used, swift-format owns layout and SwiftLint
  takes the semantic and size rules, matching the ESLint-plus-limits split in `coding-standards.md`. **[inference]**

## 6. Linux (cloud sessions) versus the Mac

- Swift's compiler, SwiftPM and SourceKit-LSP run on Ubuntu, Debian, Fedora, Amazon Linux, RHEL UBI and Windows
  ([Platform support](https://www.swift.org/platform-support/)). Official container images exist on Docker Hub
  ([Install on Linux](https://www.swift.org/install/linux/)).
- AppKit is macOS and Mac Catalyst only ([AppKit](https://developer.apple.com/documentation/appkit)). SwiftUI is
  Apple platforms only ([SwiftUI](https://developer.apple.com/documentation/swiftui)). WebKit's `WKWebView` and
  XCUIAutomation likewise list only Apple platforms on their pages above. `xcodebuild` ships only with Xcode
  ([tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)).
- **[tested]** In this cloud session, Docker was installed but its daemon was stopped. Starting `dockerd` worked,
  `docker pull swift:6.4` from Docker Hub worked, and inside it `swift test`, coverage and `swift format` all worked.
  `download.swift.org` (the swiftly installer) was not reachable, so the image is the way in here.

| Work | Linux cloud session | Needs the Mac |
|---|---|---|
| Pure Swift logic in a package that imports only Foundation (file protocol, run model, parsers): build, Swift Testing, XCTest, coverage | yes [tested] | – |
| `swift format lint/format` | yes [tested] | – |
| SwiftLint lint rules | likely (Linux binary published) [unconfirmed] | `analyze` rules |
| Python server, hooks, `analysis_*` tests (unchanged from today) | yes | – |
| Reading or checking the `.xcproj` file via `apple/xcode-project-format` | likely (builds on non-Darwin) [unconfirmed] | – |
| Anything importing AppKit, SwiftUI, WebKit or SwiftTerm/Ghostty views | no | yes |
| `xcodebuild` build, test, archive, sign, notarise | no | yes |
| UI tests, screenshots, accessibility driving | no | yes |
| Xcode MCP (`xcrun mcpbridge`) | no | yes, with Xcode open |

- Caveat on Foundation: on Linux, Foundation is the open-source swift-foundation and corelibs-foundation, not Apple's.
  **[unconfirmed]**: APIs the Mac app's core might use (`FileManager`, `JSONDecoder`, `Process`, file watching)
  behave the same. File watching is the most likely gap: FSEvents and `DispatchSource` vnode sources are
  Darwin-specific, so it would need to sit behind a protocol with a fake for tests.

### CI

- GitHub-hosted runners include `macos-26` and `macos-latest` (macOS 26, arm64), with Xcode 27 images listed. Each
  macOS image carries one major Xcode version
  ([runner-images README](https://github.com/actions/runner-images)). macOS 14 images were retired on 2 November 2026
  ([same](https://github.com/actions/runner-images)).

## Implications for the decision (ticket 11)

1. **Split the Swift code into a Foundation-only core package and a thin app target.** The core (file protocol, runs,
   notes, trust state, keymap) then builds and tests, with coverage, on Linux in cloud sessions with `swift test`
   inside `swift:6.4`. That mirrors today's `src/core` and makes most of the 90% bar reachable off the Mac. Platform
   effects such as file watching go behind protocols with fakes.
2. **Two check commands, or one that degrades.** A Linux-safe check: `swift format lint --strict`, SwiftLint
   (once its Linux binary is confirmed), `swift test --enable-coverage` with a JSON gate that filters to `Sources/`,
   and the Python checks. A Mac check adds `xcodebuild test` for the app and UI tests, with
   `-enableCodeCoverage YES` and an `xccov` gate. A cloud session can never run the app, so "every commit passes
   check" means the Linux half in the cloud and the full check on the Mac or in macOS CI.
3. **Driving the app: XCUIAutomation for recorded checks, plus one debug channel for interactive poking.** UI tests
   with `accessibilityIdentifier`s, `launchEnvironment` for the stub Claude, and `-key value` launch arguments for a
   scratch root cover the "never test against real analyses" rule. For the CDP-style quick look, a debug-only
   `.assay/requests/ui-*` handler fits the app's existing file protocol and avoids TCC prompts. Swift Testing UI tests
   (Xcode 27.3 beta) are worth adopting once 27.3 ships.
4. **Use the JSON `.xcproj` format and `xcrun xcodeproj`** so Claude edits the project file safely. This sets Xcode 27
   as the floor for development (not for users, whose floor stays macOS 26). Xcode 27 already requires macOS 26.6 on
   the Mac.
5. **Optionally add Xcode's MCP (`xcrun mcpbridge`) for local Claude Code on the Mac.** It is a convenience for
   builds, previews and diagnostics, not the check itself, since it needs Xcode open and is not scriptable in CI. Keep
   `xcodebuild` as the source of truth.
6. **Verify on the Mac before ticket 11 fixes rules:** the `xcodebuild` coverage flags, the `xccov` JSON shape, how to
   export `xcresulttool` attachments, whether `xcodebuild test` from Terminal triggers the Accessibility grant, Cmd
   shortcuts through `typeKey`, and the cost of one UI-test cycle.

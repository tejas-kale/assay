# How Claude builds, tests and drives a native Mac app

Type: research
Status: resolved

## Question

How can Claude Code develop a Swift macOS app the way AGENTS.md describes for Electron?
- building with xcodebuild or SwiftPM from the command line
- unit tests (Swift Testing, XCTest) and measuring coverage
- driving the running app without a person (XCUITest, the accessibility API, screenshots), the way CDP drives Electron today
- linting and formatting (swift-format, SwiftLint)
- what, if anything, works on Linux (in cloud sessions) and what needs a Mac

## Answer

Findings: [research/05-agent-dev-loop.md](../research/05-agent-dev-loop.md).

- **What works in Linux cloud sessions:** Foundation-only Swift builds and tests there. In the `swift:6.4` image, one `swift test` ran both Swift Testing and XCTest, gave llvm-cov coverage, and `swift format lint --strict` worked. Anything using AppKit, SwiftUI or WebKit needs the Mac, as do `xcodebuild`, UI tests and Xcode's MCP.
- **Building on the Mac:** `xcodebuild` builds and tests the app. Agents can edit the project through `xcrun xcodeproj` and the JSON `.xcproj` format (the default from Xcode 27.2). Xcode's own MCP server (`xcrun mcpbridge`) works only while Xcode is open. Xcode 27 needs macOS 26.6 or later.
- **Driving the app:** there is no CDP equivalent. XCUIAutomation fills that role: a test environment pointing at a stub Claude, `-key value` launch arguments for a scratch root, `accessibilityIdentifier`s, `typeKey` for Cmd shortcuts, and screenshots. It needs a one-time Accessibility grant. A debug-only `.assay/requests/ui-*` handler could offer quick poking through the file protocol.
- **Lint:** swift-format ships with the toolchain. SwiftLint on Linux is unconfirmed, and its type-aware rules need the Mac.
- **Implication:** a Foundation-only core package, tested anywhere, plus a thin app target, with a check split into a Linux half and a Mac/CI half.
- **Still to verify on the Mac:** the `xcodebuild` coverage flags, the shape of `xccov`'s JSON, screenshot export from `.xcresult`, and the Accessibility prompt.

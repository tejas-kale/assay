# How Claude builds, tests and drives a native Mac app

Type: research
Status: open

## Question

How can Claude Code develop a Swift macOS app the way AGENTS.md describes for Electron?
- building with xcodebuild or SwiftPM from the command line
- unit tests (Swift Testing, XCTest) and measuring coverage
- driving the running app without a person (XCUITest, the accessibility API, screenshots), the way CDP drives Electron today
- linting and formatting (swift-format, SwiftLint)
- what, if anything, works on Linux (in cloud sessions) and what needs a Mac

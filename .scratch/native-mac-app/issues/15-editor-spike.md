# Spike: CodeMirror with Vim in a WKWebView, with Assay's shortcuts

Type: prototype
Status: open
Blocked by: 01

## Question

HITL, on the Mac. Build a throwaway AppKit app hosting CodeMirror 6 with @replit/codemirror-vim and SQL highlighting in a `WKWebView` subclass. The subclass overrides `performKeyEquivalent`, so Run (Cmd-Enter) and the tab shortcuts reach the menu first. Check:
- key routing in Vim's normal, insert and visual modes, including Escape and Ctrl keys
- the white flash at load in dark mode
- memory and launch time for one and for three web views
- passing a document of about 1 MB each way through the bridge

Decide whether the editor's web view approach holds, and how keys are split between the page and the shell. See [research/02-webview-bridge.md](../research/02-webview-bridge.md).

# How the native shell hosts CodeMirror and Mermaid in web views

Type: research
Status: resolved

## Question

How should a Swift macOS 26 app host CodeMirror 6 (with @replit/codemirror-vim, SQL, Python and Markdown) and Mermaid in WKWebView? Answer from primary sources:
- bundling the JS (a build step or prebuilt assets in the app bundle)
- the message bridge both ways (WKScriptMessageHandler, callAsyncJavaScript), and passing large documents
- keyboard focus and Cmd shortcuts: which keys the web view swallows, how menu shortcuts still reach the shell, and Vim's Escape and Ctrl keys
- light and dark themes, and memory and launch cost per web view
- whether SwiftUI's WebView (macOS 26) is enough or AppKit's WKWebView is needed
- prior art: open-source Mac apps that embed CodeMirror or Monaco this way

## Answer

Findings: [research/02-webview-bridge.md](../research/02-webview-bridge.md).

- **Keyboard shortcuts decide the design.** When a WKWebView has focus, the page gets every Cmd and Ctrl key before the menu does. CodeMirror's default keymap takes Cmd-Enter and Ctrl-Shift-F/N/P, so Run and several tab shortcuts would be lost inside the editor. Vim's Escape and Ctrl keys work as they do in a browser.
- **The editor needs AppKit.** A `WKWebView` subclass overriding `performKeyEquivalent` can send Assay's own shortcuts to the menu first, as MarkEdit does. SwiftUI's macOS 26 `WebView` can't be subclassed: it is enough for a display-only Mermaid view, not for the editor.
- **Bundling:** build the JS at app build time into one file per view (git-ignored, added as an app resource), as MarkEdit does with Vite. Ship Mermaid's single-file build in the app, never from a CDN.
- **The bridge:** one `WKScriptMessageHandlerWithReply` from web to native, and `callAsyncJavaScript` with named arguments from native to web. Send the document on save or run, not on every change, or let the page fetch files through a custom URL scheme. Dark mode follows the app.
- **Only the Mac can tell:** memory and launch time per web view (keep few, long-lived), key routing in Vim normal and insert modes, the white flash at load in dark mode, and ES modules from `file://`. These become a spike.
- **Prior art:** MarkEdit (CodeMirror 6, macOS 26, active).

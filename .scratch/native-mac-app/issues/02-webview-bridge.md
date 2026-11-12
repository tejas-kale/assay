# How the native shell hosts CodeMirror and Mermaid in web views

Type: research
Status: open

## Question

How should a Swift macOS 26 app host CodeMirror 6 (with @replit/codemirror-vim, SQL, Python and Markdown) and Mermaid in WKWebView? Answer from primary sources:
- bundling the JS (a build step or prebuilt assets in the app bundle)
- the message bridge both ways (WKScriptMessageHandler, callAsyncJavaScript), and passing large documents
- keyboard focus and Cmd shortcuts: which keys the web view swallows, how menu shortcuts still reach the shell, and Vim's Escape and Ctrl keys
- light and dark themes, and memory and launch cost per web view
- whether SwiftUI's WebView (macOS 26) is enough or AppKit's WKWebView is needed
- prior art: open-source Mac apps that embed CodeMirror or Monaco this way

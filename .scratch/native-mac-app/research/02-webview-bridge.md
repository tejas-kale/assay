# Research: hosting CodeMirror and Mermaid in web views (ticket 02)

Ticket: [issues/02-webview-bridge.md](../issues/02-webview-bridge.md). Researched 12 November 2026.

**How to read this.** Each claim cites the source that owns it. **[Unconfirmed]** marks a claim no primary source
here settles; it needs a check on the Mac. Apple pages were read through their DocC JSON
(`developer.apple.com/tutorials/data/documentation/...json`); the links below go to the human-readable pages. WebKit
source was read at `main`, commit `1bc0e5f3c549`. codemirror.net and mermaid.js.org could not be reached from this
session, so CodeMirror's docs were read from the site's source repository (`codemirror/website`, commit `84be9d7`) and
Mermaid's from its docs sources in `mermaid-js/mermaid` (`develop`) and from the npm package (12.3.0).

Versions Assay uses today (`package.json`): `@codemirror/view` 6.43, `@replit/codemirror-vim` 6.4.0, `mermaid` 12.2.

---

## 1. Bundling the JavaScript

**CodeMirror needs a bundle step.** CodeMirror is "distributed as a collection of modules" that "aren't directly
loadable by the browser"; for deployment "you'll want to do classical bundling". The example uses Rollup with
`@rollup/plugin-node-resolve` and `-f iife`, giving one script loaded by a `<script>` tag.
[codemirror/website: examples/bundle](https://github.com/codemirror/website/blob/main/site/examples/bundle/index.md)

**Size.** A straightforward bundle of basic setup plus a language is "around 1 megabyte"; minified, "around 400
kilobytes (135 kilobytes when gzipped)"; a minimal editor's stripped code is "250 kilobytes (75 kilobytes gzipped)".
(Same source.) Over a local load, gzip does not apply, so the figure that matters is the minified size.

**Mermaid ships a ready single file.** The npm package's `dist/` holds `mermaid.min.js` (5,537,838 bytes, about 1.6 MB
gzipped), an esbuild IIFE that ends `globalThis["mermaid"] = ...default`, so it works from a plain `<script>` tag with no
bundler. The ESM build (`mermaid.esm.min.mjs`) is a 31 KB entry that pulls in 210 chunk files (25 MB) from
`dist/chunks/mermaid.esm.min/`. (Inspected from the npm tarball:
[registry.npmjs.org/mermaid/12.3.0](https://registry.npmjs.org/mermaid/12.3.0).)

**Prior art builds at app build time and ships one HTML file.** MarkEdit (open-source Mac Markdown editor on
CodeMirror 6, macOS 26+) builds `CoreEditor/` with Vite and `vite-plugin-singlefile` into `CoreEditor/dist/index.html`
([vite.config.mts](https://github.com/MarkEdit-app/MarkEdit/blob/main/CoreEditor/vite.config.mts),
[package.json](https://github.com/MarkEdit-app/MarkEdit/blob/main/CoreEditor/package.json)). `dist/` is git-ignored
([CoreEditor/.gitignore](https://github.com/MarkEdit-app/MarkEdit/blob/main/CoreEditor/.gitignore)); the Xcode project
lists `CoreEditor/dist/index.html` as a resource of the app target
([MarkEdit.xcodeproj/project.xcproj](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEdit.xcodeproj/project.xcproj),
line 30); CI runs `yarn install && yarn build` before `xcodebuild`
([build-and-test.yml](https://github.com/MarkEdit-app/MarkEdit/blob/main/.github/workflows/build-and-test.yml)). It also
generates the Swift/TypeScript bridge from TypeScript interfaces with Microsoft's `ts-gyb` (`yarn codegen`, same
package.json; [README](https://github.com/MarkEdit-app/MarkEdit/blob/main/README.md)).

**How to load it.** WKWebView can load bundled content with `loadFileURL(_:allowingReadAccessTo:)`
([docs](https://developer.apple.com/documentation/webkit/wkwebview/loadfileurl(_:allowingreadaccessto:))),
`loadHTMLString(_:baseURL:)` (MarkEdit does this, with `http://localhost/` as base URL:
[EditorViewController.swift](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditMac/Sources/Editor/Controllers/EditorViewController.swift)
line 199, [EditorWebView.swift](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditMac/Sources/Editor/Views/EditorWebView.swift)),
or a custom scheme via `WKURLSchemeHandler`, registered with `setURLSchemeHandler(_:forURLScheme:)` on the
configuration; Apple advises including the app's name in the scheme
([WKURLSchemeHandler](https://developer.apple.com/documentation/webkit/wkurlschemehandler),
[setURLSchemeHandler](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/seturlschemehandler(_:forurlscheme:))).
The older ProxymanApp CodeMirror-Swift package (CodeMirror 5, last commit 2022) instead ships a resource bundle inside
a Swift package and calls `load(_:mimeType:characterEncodingName:baseURL:)` with the bundle's resource URL
([CodeMirrorWebView.swift](https://github.com/ProxymanApp/CodeMirror-Swift/blob/master/Sources/CodeMirror/CodeMirrorWebView.swift),
lines 279-285).

- **[Unconfirmed]** Whether ES-module `<script type="module">` imports resolve from `file://` in WKWebView. An IIFE
  bundle, or a custom scheme, sidesteps the question; neither needs it answered.
- Offline matters: MarkEdit's Mermaid preview loads Mermaid from `cdn.jsdelivr.net` at render time
  ([mermaid.ts](https://github.com/MarkEdit-app/MarkEdit/blob/main/CoreEditor/src/modules/preview/renderers/mermaid.ts),
  line 9). Assay should bundle Mermaid in the app instead.

## 2. The message bridge

### Web to native

- `window.webkit.messageHandlers.<name>.postMessage(<body>)` calls a `WKScriptMessageHandler`
  ([docs](https://developer.apple.com/documentation/webkit/wkscriptmessagehandler)). To answer the page, implement
  `WKScriptMessageHandlerWithReply` instead; `postMessage` then returns a promise
  ([docs](https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply)).
- The message body may be `NSNumber`, `NSString`, `NSDate`, `NSArray`, `NSDictionary` or `NSNull`
  ([WKScriptMessage.body](https://developer.apple.com/documentation/webkit/wkscriptmessage/body)).
- MarkEdit uses one reply handler named `bridge` in the `.page` content world, checks `message.frameInfo.isMainFrame`,
  and dispatches on `moduleName`/`methodName` with JSON-string parameters, using the async form of the reply method
  ([EditorMessageHandler.swift](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditKit/Sources/EditorMessageHandler.swift);
  registered at line 144 of EditorViewController.swift).

### Native to web

- `callAsyncJavaScript(_:arguments:in:in:completionHandler:)` (macOS 11+) runs a function body with named arguments;
  argument values must be `NSNumber`, `NSString`, `NSDate`, `NSArray`, `NSDictionary` or `NSNull`. If the result is a
  promise, WebKit waits for it and reports rejection as `WKErrorJavaScriptAsyncFunctionResultRejected`
  ([docs](https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript(_:arguments:in:in:completionhandler:))).
  Passing text as an argument, not spliced into the script string, avoids escaping bugs.
- `WKContentWorld` separates the app's scripts' globals from the page's; the DOM is shared across worlds
  ([docs](https://developer.apple.com/documentation/webkit/wkcontentworld)). With an app-owned page, `.page` is fine.
- MarkEdit wraps both directions in typed calls such as `webModules.core.resetEditor(...)` and uses
  `callAsyncJavaScript("return await …", contentWorld: .page)` for async ones
  ([WKWebView+Extension.swift](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditKit/Sources/Extensions/WKWebView+Extension.swift),
  line 116; [WebBridgeCore.swift](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditKit/Sources/Bridge/Web/Generated/WebBridgeCore.swift)).

### Large documents

- **[Unconfirmed]** Apple documents no size limit for message bodies or `callAsyncJavaScript` arguments. Each crosses a
  process boundary (see section 4), so a large string is copied. Measure with a realistic file before choosing.
- CodeMirror itself copes with size: it renders only the viewport plus a margin, and stores the document "split by
  line in a tree-shaped data structure" ([guide: Viewport](https://github.com/codemirror/website/blob/main/site/docs/guide/index.md),
  "Viewport" and "Documents"); the "Huge Document" example loads "a few million lines"
  ([examples/million](https://github.com/codemirror/website/blob/main/site/examples/million/index.md)).
- Two ways to keep the bridge small, from the APIs above: (a) let the page fetch the file itself from a custom scheme
  (`WKURLSchemeHandler`, or `URLSchemeHandler` for SwiftUI, which streams a response then data
  ([docs](https://developer.apple.com/documentation/webkit/urlschemehandler))); (b) send the text once and send back
  only change sets or the text on request. Assay's Code editor today posts the whole document on every change
  (`update.state.doc.toString()` in `src/renderer/components/CodeView.tsx`); across a process boundary that should become
  "on save or run" or diff-based.

## 3. Keyboard focus, Cmd shortcuts, Vim's Escape and Ctrl keys

### How AppKit routes keys

"`NSApplication` ... sends a `performKeyEquivalent:` message to the key `NSWindow` object ... down its view hierarchy
... If no object in the view hierarchy handles the key equivalent, `NSApp` then sends `performKeyEquivalent:` to the
menus in the menu bar." Control-key events also go through `performKeyEquivalent:` first. So **views get key equivalents
before the main menu.**
([Cocoa Event Handling Guide: Handling Key Events](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/HandlingKeyEvents/HandlingKeyEvents.html))

### What WKWebView does with them

From [WebViewImpl.mm](https://github.com/WebKit/WebKit/blob/1bc0e5f3c549/Source/WebKit/UIProcess/mac/WebViewImpl.mm):

- `performKeyEquivalent` (line 6740): if the web view is the window's first responder, it sends the event to the page
  ("This lets webpages have a crack at intercepting key-modified keypresses") and **returns YES**, so the menu does not
  see it yet. If the web view is not first responder, it defers to the normal NSView behaviour.
- `doneWithKeyEvent` (line 5826): when the page has finished with the event, if it was **not** handled, WebKit re-sends
  it with `[NSApp sendEvent:]`; the second pass skips the page (`m_keyDownEventBeingResent`), so the menu then gets it.
  If the page **did** handle it (JavaScript called `preventDefault`), it stops there.
- Plain Escape and Cmd-. become `cancelOperation:` and reach `performKeyEquivalent` as Escape only after that; WebKit
  passes them on rather than re-interpreting them (line 6751 comment). Escape as a `keyDown` goes to the page first
  (line 6791).

**Consequence: in a web view, the page wins every Cmd and Ctrl shortcut it calls `preventDefault` on, and the menu only
gets what the page leaves alone.** This is the reverse of Electron Assay, where main's `before-input-event` sees keys
before the page.

### What CodeMirror and Vim consume

- `@replit/codemirror-vim` maps Ctrl to `C-`, Option to `A-`, Cmd to `M-` (`vimKeyFromEvent`,
  [vim.js line 1222](https://github.com/replit/codemirror-vim/blob/master/packages/codemirror-vim-core/vim.js)) and calls
  `preventDefault` only when Vim handled the key
  ([index.ts line 249](https://github.com/replit/codemirror-vim/blob/master/packages/codemirror-vim/src/index.ts)). Its
  default keymap binds no `M-` keys but many Ctrl keys: `<C-[>`, `<C-c>` and `<C-Esc>` (to Escape in insert mode),
  `<C-a> <C-b> <C-d> <C-e> <C-f> <C-n> <C-o> <C-p> <C-r> <C-u> <C-v> <C-w> <C-x> <C-y>` and others (same vim.js).
  Escape reaches Vim as a normal `keydown`, so it works as it does in a browser.
- CodeMirror's `defaultKeymap`, which Assay includes after `vim()`, binds `Mod-Enter` (insertBlankLine), `Mod-i`,
  `Mod-[`, `Mod-]`, `Mod-/`, `Shift-Mod-k` and more; on Mac its standard keymap adds the Emacs-style Ctrl bindings
  with Shift variants (`Ctrl-b/f/p/n/a/e` with `shift: select…`, plus `Ctrl-d/h/k/o/t/v`)
  ([codemirror/commands src/commands.ts](https://github.com/codemirror/commands/blob/main/src/commands.ts), lines
  973-1100). Some carry `preventDefault: true`; CodeMirror also prevents default when a command runs (behaviour of
  `keymap`, [inferred from the same file's binding flags; **unconfirmed** in the view package's docs]).
- **Clashes with Assay's own keymap** (`src/core/keymap.ts`, `src/core/tabs.ts`): Cmd-Enter (`code.run`) is
  `Mod-Enter` in CodeMirror; Ctrl-Shift-F/N/P (Files, Notes, Plots tabs) are `selectCharRight`, `selectLineDown`,
  `selectLineUp` in the Mac standard keymap. Inside a focused editor web view these would never reach the native menu.
  **[Unconfirmed]** whether Vim's normal mode lets them through to `defaultKeymap`: Vim returns false for unmapped
  keys, so `defaultKeymap` should then run.

### The fix, and what prior art does

- A `WKWebView` subclass can override `performKeyEquivalent(with:)` to decide first. MarkEdit does this to stop a beep
  on Ctrl-Cmd-arrows ([EditorWebView.swift line 78](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditMac/Sources/Editor/Views/EditorWebView.swift)).
  For Assay, the override would hand a reserved set of shell shortcuts to `NSApp.mainMenu?.performKeyEquivalent(with:)`
  before calling `super`, and the JS side would also drop those keys from its keymaps (defence in depth).
  **[Unconfirmed]** that calling the main menu from inside the view's override behaves cleanly in every case; it is
  public `NSMenu` API, but test it.
- Focus: WebKit only forwards key equivalents to the page when the web view is the window's **first responder**
  (line 6740 above), so focus moves are `window.makeFirstResponder(webView)` on the native side plus `view.focus()` in
  CodeMirror. MarkEdit overrides `resignFirstResponder` to tell its controller (EditorWebView.swift).

## 4. Light and dark themes; memory and launch cost

### Themes

- WebKit takes the page's dark appearance from the web view's `effectiveAppearance` (`effectiveAppearanceIsDark`,
  WebViewImpl.mm line 7221) and pushes it into the page when it changes (`effectiveAppearanceDidChange`, line 7212 →
  [WebPageProxy::effectiveAppearanceDidChange](https://github.com/WebKit/WebKit/blob/1bc0e5f3c549/Source/WebKit/UIProcess/WebPageProxy.cpp)
  → `setUseColorAppearance`). So CSS `prefers-color-scheme` follows the app, or a per-view `appearance` override.
  **[Unconfirmed in source read here]** the final step from `Page::setUseColorAppearance` to the media query; it is
  standard Safari behaviour.
- CodeMirror: a theme passes `{dark: true}` so default styles adapt; base themes can use `&dark`/`&light` selectors
  ([examples/styling](https://github.com/codemirror/website/blob/main/site/examples/styling/index.md)). Switch at run
  time by reconfiguring a `Compartment` in a transaction
  ([guide](https://github.com/codemirror/website/blob/main/site/docs/guide/index.md), "Extension" section). MarkEdit
  keeps its theme in a `Compartment` and observes `NSApp.effectiveAppearance` on the Swift side
  ([config.ts](https://github.com/MarkEdit-app/MarkEdit/blob/main/CoreEditor/src/config.ts),
  [AppDelegate.swift](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditMac/Sources/Main/Application/AppDelegate.swift)).
- Mermaid: themes include `default`, `dark`, `base` (the only customisable one, via `themeVariables`) and others; set
  `darkMode: true` for derived colours ([theming.md](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/config/theming.md)).
  Mermaid holds one global config, so re-render on appearance change; MarkEdit re-renders on a `prefers-color-scheme`
  change listener (mermaid.ts). Assay already renders with `theme: 'base'` and its own `themeVariables`
  (`src/renderer/components/Mermaid.tsx`), which carries over as is.
- Mermaid's `securityLevel` defaults to `strict` (HTML in labels encoded, clicks disabled); `sandbox` renders in an
  iframe ([usage.md](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/config/usage.md),
  "securityLevel"). Use `mermaid.render(id, text)` with `startOnLoad: false` (same page). Assay uses `strict` today.
- **White flash.** macOS has no public `isOpaque`/`drawsBackground` setter on WKWebView (not in the
  [WKWebView topics](https://developer.apple.com/documentation/webkit/wkwebview)). MarkEdit overrides the private
  `_drawsBackground` on a configuration subclass to avoid "the initial white flash in dark mode"
  ([WebKit+Extension.swift line 23](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditCore/Sources/Extensions/WebKit+Extension.swift)).
  The public alternatives are a page whose first CSS paints the right background, and
  `underPageBackgroundColor` ([docs](https://developer.apple.com/documentation/webkit/wkwebview/underpagebackgroundcolor)).
  **[Unconfirmed]** whether those alone remove the flash.

### Memory and launch cost

- WebKit renders each web view's content in separate processes; "by default, WebKit gives each web view its own
  process space until it reaches an implementation-defined process limit"
  ([WKProcessPool](https://developer.apple.com/documentation/webkit/wkprocesspool)). `WKProcessPool` is deprecated since
  macOS 12: "Creating and using multiple instances of WKProcessPool no longer has any effect" (same page). So an app
  has no public way to make its web views share a process.
- **[Unconfirmed]** Per-web-view memory and cold-start time. No Apple source gives figures. Measure on the Mac with
  Activity Monitor / Instruments ("WebContent" processes) for: one editor view, one Mermaid view, and N views.
- MarkEdit's tuning shows where the cost lies, all through **private SPI**: start the WebContent process at init
  instead of first load (`_setDelaysWebProcessLaunchUntilFirstLoad:`), skip waiting for first paint
  (`_setWaitsForPaintAfterViewDidMoveToWindow:`), stop App Nap and DOM-timer throttling of hidden pages, and switch
  off service workers and DRM features "with eager initialization cost"
  ([WebKit+Extension.swift](https://github.com/MarkEdit-app/MarkEdit/blob/main/MarkEditCore/Sources/Extensions/WebKit+Extension.swift)).
  Private SPI is a stability risk on each macOS release; Assay ships Developer ID only, so App Review is not the
  concern (map.md).
- Debugging: `isInspectable = true` lets Safari's Web Inspector attach (macOS 13.3+, default false)
  ([docs](https://developer.apple.com/documentation/webkit/wkwebview/isinspectable)).

## 5. SwiftUI `WebView` (macOS 26) or AppKit `WKWebView`

What SwiftUI's WebKit API offers (all macOS 26.0+):

- `WebView` shows a URL or a `WebPage`; modifiers cover scrolling, back/forward and magnification gestures and link
  previews ([WebView](https://developer.apple.com/documentation/webkit/webview-swift.struct)).
- `WebPage` (an `Observable` class) loads content and runs `callJavaScript(_:arguments:in:contentWorld:)`, with the same
  promise semantics as `callAsyncJavaScript` ([WebPage](https://developer.apple.com/documentation/webkit/webpage),
  [callJavaScript](https://developer.apple.com/documentation/webkit/webpage/calljavascript(_:arguments:in:contentworld:))).
- `WebPage.Configuration` has `userContentController` (a `WKUserContentController`, so script message handlers and user
  scripts work) and `urlSchemeHandlers`
  ([Configuration](https://developer.apple.com/documentation/webkit/webpage/configuration),
  [userContentController](https://developer.apple.com/documentation/webkit/webpage/configuration/usercontentcontroller),
  [URLSchemeHandler](https://developer.apple.com/documentation/webkit/urlschemehandler)).
- The WWDC25 session "Meet WebKit for SwiftUI" presents it as the new API and invites migration; it does not list
  limits against WKWebView ([WWDC25 231](https://developer.apple.com/videos/play/wwdc2025/231/)).

What it lacks for Assay:

- `WebView` is a struct; there is nothing to subclass, so no `performKeyEquivalent(with:)` override (section 3), no
  `resignFirstResponder` hook and no context-menu (`willOpenMenu`) override. Its documented topics list no keyboard or
  first-responder control (WebView page, "Topics").
- **[Unconfirmed]** whether SwiftUI exposes the underlying `WKWebView`; no public API for it appears in the
  `WebView` or `WebPage` topics.
- MarkEdit, which targets macOS 26 too, still uses an AppKit `WKWebView` subclass (EditorWebView.swift).

So SwiftUI's `WebView` is enough for a **display-only** Mermaid view, but the **editor** needs AppKit `WKWebView`
(wrapped in `NSViewRepresentable` if the shell is SwiftUI) for the key-equivalent override.

## 6. Prior art

| App | What it embeds | How | Source |
| --- | --- | --- | --- |
| MarkEdit (MIT, active, macOS 26+) | CodeMirror 6, Mermaid preview via extension | AppKit `WKWebView` subclass; Vite single-file `index.html` built before Xcode; `WKScriptMessageHandlerWithReply` bridge with generated code (ts-gyb); `performKeyEquivalent` override; private SPI for launch speed and background | [github.com/MarkEdit-app/MarkEdit](https://github.com/MarkEdit-app/MarkEdit) |
| CodeMirror-Swift (Proxyman, 2022) | CodeMirror 5 | Swift package resource bundle; `evaluateJavaScript` calls | [github.com/ProxymanApp/CodeMirror-Swift](https://github.com/ProxymanApp/CodeMirror-Swift) |
| mdown | Monaco | Electron, not WKWebView, so not prior art for this | [github.com/jakerb/mdown](https://github.com/jakerb/mdown) (`package.json`) |

- No open-source Mac app embedding **Monaco** in WKWebView turned up in a web search **[Unconfirmed: absence, not
  proof]**. None found uses **@replit/codemirror-vim** inside WKWebView either; MarkEdit has no Vim mode in its
  dependencies (CoreEditor/package.json).

---

## Implications for the decision

1. **Use AppKit `WKWebView` for the editor**, subclassed so `performKeyEquivalent(with:)` sends Assay's reserved
   shortcuts (Cmd-Enter, Cmd-P/F/E/N/W, Cmd-1..9, Ctrl-1/2/3/0, Ctrl-Shift-letter tabs) to the main menu before the page.
   Also strip those keys from the CodeMirror keymaps in JS. Without this, Cmd-Enter and Ctrl-Shift-F/N/P stop working
   inside the editor. SwiftUI's `WebView` is acceptable for a display-only Mermaid view, but one wrapper for both is
   simpler.
2. **Build the JS at app build time into one file per view** (Vite or Rollup, IIFE or single-file HTML), git-ignored,
   added as an app resource, with CI running the JS build before `xcodebuild`, as MarkEdit does. Bundle
   `mermaid.min.js` (5.5 MB, one file); never load from a CDN.
3. **Keep web views few and long-lived** (one editor, one Mermaid renderer) and swap documents inside them: there is no
   public way to share a web content process, and the per-view cost is unmeasured. Measure memory and cold start on the
   Mac early; it decides whether Mermaid stays in a web view or goes to MermaidKit (map.md).
4. **Bridge:** one named `WKScriptMessageHandlerWithReply` web to native; `callAsyncJavaScript` with arguments (not string
   splicing) native to web; a small typed protocol, hand-written or generated. Do not post the whole document per
   keystroke; serve files to the page through a custom scheme or send text once and pull it on save or run.
5. **The one rule is untouched**: the editor only edits text. Runs still go from Swift into `.assay/requests/` and the
   server, so nothing in the web view executes analysis code.
6. **Themes are cheap**: appearance flows into `prefers-color-scheme`; CodeMirror themes switch through a `Compartment`
   and Mermaid re-renders with Assay's existing `base` theme variables. Plan for the dark-mode white flash; the clean fix
   uses private SPI, so decide whether to accept that.
7. **Verify on the Mac before committing**: the Unconfirmed items above, chiefly key routing with Vim in normal and
   insert modes, the white flash, ES modules from `file://`, and memory per web view.

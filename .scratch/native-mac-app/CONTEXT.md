# Context: native Mac Assay

## Glossary

- **Hybrid**: the native Mac app in which the window, tabs, file handling and terminal are native, while the code editor (CodeMirror with Vim) and Mermaid run in embedded web views. It is the first phase; the fully native app replaces the web views later.
- **Native shell**: the part of the hybrid written for macOS itself: the windows, tabs, menus, keyboard shortcuts and file access.
- **Web view component**: one piece of web UI hosted inside the native shell (the editor, Mermaid), talking to the shell through a message bridge. Not a web app: it never reads files or runs code itself.
- **File protocol**: the files through which the app and the server talk (`.assay/requests/`, `.assay/replies/`, `runs.json`, the trust files, `queries/` runs). The server owns it; the app reads and requests.
- **Parity bar**: the features the hybrid must have before the user uses it instead of Electron Assay day to day.
- **Launcher**: whatever starts Claude for an analysis: plain `claude`, or a wrapper such as the Podman one that runs Claude in a container. Described by the launch contract.

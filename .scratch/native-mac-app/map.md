# Map: Assay as a native Mac app (hybrid phase)

Label: wayfinder:map

## Destination

A build-ready plan for the **hybrid** Assay: a native Swift Mac app, with CodeMirror (and Vim) and Mermaid in web views, and the server and hooks in Python. When this map is done, every decision is made and the work is sliced into tickets ready to execute. Nothing is left to decide before building starts.

## Notes

- **Independent app, shared format.** The new app lives in its own repository and is open source. It opens the same analysis folders as Electron Assay (`queries/`, `.assay/`, root notes, `trusted/`, `dictionaries/`), so the user can switch day to day. Electron Assay retires once the hybrid meets the parity bar.
- **The one rule carries over unchanged:** there is one place where code runs, and every run is recorded.
- **Parity bar (decided):** a core subset first: the Claude terminal and the Code, Data, History, Notes and Trust tabs, plus the Podman launcher contract. The other tabs follow later.
- **Python, not Node, in the hybrid (decided).** The MCP server and the hooks move to Python. Python owns the file protocol; the Swift app reads it.
- **macOS 26 Tahoe is the floor (decided).**
- **Build host:** the user's Mac, using their paid Apple Developer account. This cloud session runs on Linux and cannot build or run a Mac app.
- **Learning goal:** the user wants to understand how a Mac app is built well enough to lead and contribute, without learning syntax. Every resolved ticket ends with an explainer written with the **show-me** skill (the user is installing it): what the piece is, how macOS does it, and the trade-off taken.
- **Skills for sessions:** grilling and domain-modeling for grilling tickets; research for research tickets; show-me for each resolution's explainer. Glossary: `CONTEXT.md` beside this map.
- **Tracker:** local markdown (`issues/NN-<slug>.md`, `Type:`, `Status:`, `Blocked by:` lines). Research findings go in `research/`.

## Decisions so far

<!-- one line per resolved ticket: [title](issues/NN-slug.md): gist -->

- [Which terminal component runs Claude Code in the native shell](issues/03-terminal-choice.md): SwiftTerm or GhosttyKit, decided by a side-by-side spike on the Mac; libghostty-vt waits for the fully native phase.
- [What the TypeScript server, hooks and shared core do, and what moves to Python](issues/04-server-inventory.md): mostly orchestration over Python that already exists; the parsing rules shared with the app would be written twice unless Python serves parsed views; the launch contract and the Podman wrapper must change together.

## Not yet specified

- **Mermaid in the hybrid:** a web view (faithful to mermaid.js) or MermaidKit (native, ignores `classDef`, `style`, `click` and `init`). This turns on how the web-view bridge works out, and on how much the user's notes rely on styling.
- **The tabs outside the core subset** (Overview, Plots, Steps, Threads, Files): their order, and whether each needs a web view.
- **The Doctor and first-run setup** once Node and brew uv are gone: what it checks, and how the app installs uv and Python.
- **Moving off Electron Assay:** what happens to its settings and the user data folder, and when Electron Assay stops being maintained.
- **The Swift side's domain model:** how `src/core`'s app-only modules (keymap, tabs, theme, search, views) map onto Swift types. This waits on the architecture decision.

## Out of scope

- **The fully native phase** (replacing the web views with native editors and Mermaid). It will be a later map, informed by what the hybrid teaches.
- **The Mac App Store.** Its sandbox rules out downloading and running Python. Distribution is Developer ID only.

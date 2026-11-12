# Security

What Assay defends, where its defences stop, and the risks it accepts. The audit that shaped this is
`docs/security-audit-2026-11.md`; read this before changing a hook, a tool, an IPC handler, the updater or CI.

## Threats

1. **Prompt injection through data.** A query result, a file or a note carries text that steers Claude past Assay's
   rules: running Python outside the kernel, writing `trusted/` or `dictionaries/`, approving its own calculation,
   passing its run off as the user's.
2. **Tampered updates.** A release, or the app's installed backend, that the user did not ship.
3. **Malicious dependencies.** An npm or PyPI package, or one of their install scripts, that runs hostile code in the
   app, on a user's Mac or on the release runner.
4. **Hostile content in the UI.** Markdown, Mermaid, HTML or a file in an analysis that reaches script in the renderer
   (and so every IPC handler) or the Mac's default handlers.

## The isolation boundary

Claude's `python` tool runs any code Claude writes, by design, in a kernel that runs as the user; Bash does too. No
hook can stop code that already runs. So Assay's rules hold in two strengths:

- **Against a Claude that follows the rules**, everywhere: the hooks, the tools and the prompt keep it on the path.
- **Against code Claude was steered into running**, only where a launcher contains it (docs/process/launch-contract.md):
  the Podman wrapper, or Claude Code's own sandbox. Assay does not contain code execution; the launcher does.

With plain Claude Code and no sandbox, an injected Claude can do whatever the user's account can. That is the user's
choice of launcher, not a hole in Assay.

## What Assay guarantees

- **One place where code runs.** The Bash guard refuses Python through Bash in every form it can parse
  (`src/core/bashGuard.ts`); Claude's Python runs in the kernel the app shows, and every run is numbered and saved.
- **Runs say who made them.** Only the server writes a run's header: Claude's code cannot claim `author: user` or
  `trusted:` (`withoutHeaderLines`), and a trusted header is read from the leading comment lines only.
- **Assay's own files are not Claude's to write.** The Write guard (Write, Edit, MultiEdit, NotebookEdit) refuses the
  shared `trusted/`, `dictionaries/` and `notes/`, another analysis, the analysis's `.assay/` and `queries/`, both
  `.git` folders, and `ASSAY_BACKEND` and `ASSAY_VENV`. Paths are resolved through symlinks, dangling ones included,
  and compared ignoring case.
- **What goes into the prompt is data.** The prompt hook keeps only well-formed user runs, and puts step notices and
  the title in as one capped line each.
- **The renderer runs only the app's script.** The built app's policy (`src/core/csp.ts`) allows no inline or
  evaluated script, no frames, objects, base or form targets. Mermaid draws with `securityLevel: 'strict'`; notes are
  drawn as React text, never HTML. Windows open nothing, navigate nowhere and attach no webviews; every IPC handler
  checks its sender and arguments, and paths go through `safePath.ts` and a realpath check.
- **Files open safely.** Only documents that are not executable open in their default app; anything else is shown
  in Finder. Linked notes are refused. The root cannot be the home folder or above it.
- **Updates come signed from the one repo.** The feed is fixed (`tejas-kale/assay`, HTTPS); macOS checks each update
  against the installed app's signature; no downgrades, prereleases or differential downloads; the token stays in the
  Keychain and never reaches the renderer. The installed backend is hashed at each launch and copied again if edited.
- **Releases come from main.** Only the release job names the signing secrets, through the `release` environment that
  only main may use; its checkout keeps no token; no dependency's install script runs there; the built app's fuses
  are checked (`scripts/fuse-check.ts`). Every action is pinned by commit, uv and pip-audit by version.
- **Dependencies are locked and audited.** Both lockfiles hold hashes and only the official registries; CI runs
  `npm audit --audit-level=high` and `pip-audit --require-hashes` on every Python group.

`scripts/workflow.test.ts`, `scripts/fuse-check.test.ts` and the tests named in the audit pin each of these.

## Open decisions

PI-1 (critical) and PI-2 (high) are open: a review's answer arrives as a file the kernel can also write, and "trusted"
means "committed in the root's git", which the kernel can also do. Both need trust to rest on something only the app
writes, out of reach of the launcher's container:

- **The app answers on the host.** Main copies and commits the approved files itself when the user presses Trust;
  the server keeps the check but loses `trust-answer`.
- **Trust is recorded where Claude cannot write.** Either the launcher mounts `trusted/`, `dictionaries/` and the
  root's `.git` read-only, or the app keeps the approved hashes in its own data folder, mounted read-only like
  `ASSAY_BACKEND`, and a calculation is trusted only when its hash is there.

UI-3 (medium) is fixed in code, untried on a Mac: the packaged renderer loads from the `app://assay` scheme
(`src/core/appProtocol.ts` decides which file a request may read, `src/main/appScheme.ts` serves it), so `'self'` means
the app alone, and `grantFileProtocolExtraPrivileges` is off. It needs the app run on a Mac or in CI's smoke test.

## Accepted lows

| Id | Risk | Why it is accepted |
|---|---|---|
| L-1 | The Bash guard cannot see Python started by another program (`perl -e`, `node -e`, a Makefile), by `pytest` running a `conftest.py`, or by `pip install` running a package's build. It also does not model shell constructs that hide a command: functions, aliases, `bash <<EOF` heredocs fed to a shell, and similar. | The guard keeps a rule-following Claude on the recorded path; it is not a sandbox, and these forms need code that already runs or deliberate evasion. Isolation is the launcher's job (Python off the PATH of Claude's Bash). pytest and package commands stay allowed on purpose. |
| L-2 | Tool results (rows, stdout, tracebacks) are not framed as untrusted data. (PI-7) | Claude Code already treats tool results as data, not instructions; a banner on every result would cost tokens on every call for little. |
| L-3 | The venv's installed files are not hashed again at launch. | Hundreds of megabytes per launch; the Write guard refuses `ASSAY_VENV`, and code in the kernel can change anything the user can, venv or not. |
| L-4 | The hardened runtime keeps `allow-unsigned-executable-memory`. (UP-6) | Electron may need only `allow-jit`, but an update that cannot launch would reach every user before anyone saw it. Remove it after a signed build without it has run on the Mac. |
| L-5 | The updater cannot check that the pasted token is limited to Contents read-only on this repo. (UP-8) | GitHub does not report a fine-grained token's scope; the feed's owner and repo are fixed, and the token never leaves main. |
| L-6 | The pinned setuptools build backend is fetched by version, not by hash. | uv's build constraints pin versions only; PyPI never lets a published file be replaced, so a pinned version's files cannot change under it. |
| L-7 | The kernel puts the analysis folder first on `sys.path`, so a stray `pandas.py` shadows pandas. (DEP-8) | ipykernel puts the working folder first anyway, and the kernel runs Claude's code by design; moving it would gain nothing. Assay's own helpers run with `-I`, so this reaches only the kernel (PI-9). |
| L-8 | `npm audit` reports moderate advisories (minimatch ReDoS) in ESLint, typescript-eslint and electron-builder. | Build and lint tools only, never shipped; their glob patterns come from the repo. The CI gate is high and above. |
| L-9 | A symlinked `.assay/requests/` sends the app's request files elsewhere. | `.assay/` is refused to Write by name and through any link (PI-6). The channel's trust requests are PI-1, an open decision. |
| L-10 | The Write guard compares paths without Unicode normalisation (`trusted​/` passes) and does not guard paths outside the root such as `~/.claude/settings.json`. | A zero-width name does not reach the real folder; paths outside the root are the launcher's and Claude Code's permissions to guard. |

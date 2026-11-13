# Testing

`npm run check` is the gate: typecheck, ESLint, the node tests with coverage, ruff, pytest with coverage, then the
coverage bar. Rich-conversation mod tests also run with Claude Code 2.1.323 or later (`claude plugin test plugin`), without sign-in or model requests. `git push` runs it through `.githooks/pre-push` (`scripts/postinstall.mjs` sets `core.hooksPath`; `.githooks/post-commit` and `post-rewrite` still run the clone's own hooks in `.git/hooks`); CI runs
the same checks, so `--no-verify` only delays a failure.

## Unit tests

| What | Where | Run |
|---|---|---|
| Pure logic | `src/core/*.test.ts` | `npm run test:node` |
| MCP server | `src/server/*.test.ts` | `npm run test:node` |
| Hooks, as bundled scripts on stdin | `src/hooks/hooks.test.ts` | `npm run test:node` |
| Scripts (the coverage bar, versions, release paths) | `scripts/*.test.ts` | `npm run test:node` |
| Python helpers and the kernel | `python/tests/test_*.py` | `npm run test:py` |

- Node tests use `node:test`; `src/testing/expect.ts` gives them a jest-style `expect`.
- Python runs from `python/`'s locked project with its dev group (ruff, pytest-cov), synced by uv into the root
  `.venv`. `scripts/py.sh <command>` runs any command there.
- Fakes: a stub `python` script stands in for the venv in the hook tests; the MCP SDK's client stands in for Claude.
  The unit tests never start a real kernel.
- `src/renderer` and `src/main` have no unit tests. When a component or main holds a decision worth testing, move the
  decision into `src/core` as a pure function and test it there, as `tabs.ts` and `stepsRequests.ts` do.

## Integration tests

`npm run test:integration` runs `tests/integration/*.test.ts`, outside `npm run check` (CI runs them after the unit
job, `docs/developer/ci-release.md`). They need uv and PyPI; nothing reaches Databricks, Postgres or a real Claude.

- `backend.test.ts`: the bundled server over MCP with a real kernel in a venv built from `python/uv.lock` as the
  packaged app builds its own (or the one `ASSAY_TEST_VENV` names), on a scratch root that is a git repository with trusted pieces committed. SQL and
  Python runs, the app's requests, Steps, the include expansion, and the bundled hooks on real files.
- `app.test.ts`: the built app under playwright-core's Electron driver, on a scratch user data folder and root, with
  `fixtures/stub-claude.mjs` as Claude (it starts the real server and keeps it open). It opens the analysis, runs SQL
  from the Code tab with Cmd+Enter (sent through main, since CDP keys never reach `before-input-event`), and checks
  Data, History and Steps. Linux only, since only there can it move the app's user data to a scratch folder before
  launch; it needs a display (`xvfb-run`), and is skipped without one and on a Mac.
- `tests/integration/harness.ts` builds the backend's world. `fixtures/bin/databricks`, first on PATH, answers queries with
  rows chosen by the SQL's text. Trusted calculations reach the warehouse through the Python connector, which no fake
  answers.
- In the sandbox, esbuild's binary in `node_modules` is the Mac's: set `ESBUILD_BINARY_PATH` to a Linux esbuild of
  the same version.

## Coverage

The bar is 90% of lines and of branches, per file, in `src/core`, `src/server`, `src/hooks` and `python/` (tests
excluded). A file no test loads counts as 0%, in a folder without `__init__.py` too. Python coverage follows subprocesses, so the kernel's `serve` counts.
Reports land in `coverage/` (ignored by git).

## No baselines

Every file meets the bar, with no exceptions recorded anywhere (slice 11f emptied and deleted the old baselines):

- ESLint and ruff fail on any violation. Fix the code; never add `eslint-disable`, `# noqa` or a per-file ignore.
- `npm run coverage-bar` (`scripts/coverage-bar.ts`) fails on any file in scope below 90% on lines or branches, and
  on an `eslint-suppressions.json`, which would let ESLint skip the violations it lists.

## Conversation mod

`npm run test:mod` bundles the pure row model and mounts tool rows with Claude Code’s own test kit. It exercises
terminal and desktop trees and presses buttons, stubbing filesystem, clipboard and process boundaries. It does not
paint a terminal or start a live model session. CI provisions Claude Code 2.1.323 from its native Linux package using the pinned, hashed lockfile in
`scripts/mod-runner/`, with install scripts disabled and the runner dependency audited.

`plugin/node-tests/` also drives the exported render registration boundary with an in-memory surface and filesystem,
so `npm run test:node` measures each hand-written `plugin/hooks/conversation*.js` file. The generated
`conversation-model.js` is excluded; its source modules in `src/core` are measured directly. The same per-file 90%
line and branch bar applies to hand-written mod files. These checks supplement the native mounted tests.

The edit/re-run helper is tested both as its TypeScript source process and its shipped bundle, including a
controlling PTY, real requests and symlink refusals. Its source also meets the enforced per-file 90% coverage bar. The backend integration test verifies those requests become new user runs with source provenance.
Live acceptance still requires Ghostty; use `specs/notes/rich-conversation-acceptance.md`.

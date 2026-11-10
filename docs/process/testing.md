# Testing

`npm run check` is the gate: typecheck, ESLint, the node tests with coverage, ruff, pytest with coverage, then the
ratchet. `git push` runs it through `.githooks/pre-push` (`scripts/postinstall.mjs` sets `core.hooksPath`; `.githooks/post-commit` and `post-rewrite` still run the clone's own hooks in `.git/hooks`); CI runs
the same checks, so `--no-verify` only delays a failure.

## Unit tests

| What | Where | Run |
|---|---|---|
| Pure logic | `src/core/*.test.ts` | `npm run test:node` |
| MCP server | `src/server/*.test.ts` | `npm run test:node` |
| Hooks, as bundled scripts on stdin | `src/hooks/hooks.test.ts` | `npm run test:node` |
| Scripts (the ratchet) | `scripts/*.test.ts` | `npm run test:node` |
| Python helpers and the kernel | `python/tests/test_*.py` | `npm run test:py` |

- Node tests use `node:test`; `src/testing/expect.ts` gives them a jest-style `expect`.
- Python runs from `python/`'s locked project with its dev group (ruff, pytest-cov), synced by uv into the root
  `.venv`. `scripts/py.sh <command>` runs any command there.
- Fakes: a stub `python` script stands in for the venv in the hook tests; the MCP SDK's client stands in for Claude.
  The unit tests never start a real kernel.
- `src/renderer` and `src/main` have no unit tests. When a component or main holds a decision worth testing, move the
  decision into `src/core` as a pure function and test it there, as `dataTabs.ts` and `stepsRequests.ts` do.

## Integration tests

`npm run test:integration` runs `tests/integration/*.test.ts`, outside `npm run check` (CI runs them after the unit
job, `docs/process/ci-release.md`). They need uv and PyPI; nothing reaches Databricks, Postgres or a real Claude.

- `backend.test.ts`: the bundled server over MCP with a real kernel in a venv `python/tests/test_venv.sh` builds (or
  the one `ASSAY_TEST_VENV` names), on a scratch root that is a git repository with trusted pieces committed. SQL and
  Python runs, the app's requests, Steps, the include expansion, and the bundled hooks on real files.
- `app.test.ts`: the built app under playwright-core's Electron driver, on a scratch user data folder and root, with
  `fixtures/stub-claude.mjs` as Claude (it starts the real server and keeps it open). It opens the analysis, runs SQL
  from the Code tab with Cmd+Enter (sent through main, since CDP keys never reach `before-input-event`), and checks
  Data, History and Steps. On Linux it needs a display (`xvfb-run`); without one it is skipped.
- `tests/integration/harness.ts` builds the backend's world. `fixtures/bin/databricks`, first on PATH, answers queries with
  rows chosen by the SQL's text. Trusted calculations reach the warehouse through the Python connector, which no fake
  answers.
- In the sandbox, esbuild's binary in `node_modules` is the Mac's: set `ESBUILD_BINARY_PATH` to a Linux esbuild of
  the same version.

## Coverage

The bar is 90% of lines and of branches, per file, in `src/core`, `src/server`, `src/hooks` and `python/` (tests
excluded). A file no test loads counts as 0%, in a folder without `__init__.py` too. Python coverage follows subprocesses, so the kernel's `serve` counts.
Reports land in `coverage/` (ignored by git).

## The baselines

Today's code is below the bar in places. Three committed files record where, and each may only shrink:

- `eslint-suppressions.json`: ESLint's bulk suppressions. A new violation fails. When a count falls, ESLint fails
  until `npm run lint:prune` writes the smaller file. ESLint only checks the files it lints, so the ratchet flags the
  suppressions of a deleted file.
- `python/ruff-baseline.json`: ruff's counts per file and rule, kept by `scripts/ratchet.ts`. A count that grows, or
  a new file or rule, fails.
- `coverage-baseline.json`: line and branch percentages of the files below the bar, kept by `scripts/ratchet.ts`. A
  file in it may not fall more than half a point below its figures (a test that races can miss a branch in one run of
  many; the figures themselves never move down); a file not in it must reach 90% on both; a file reaching 90% on its
  own figures leaves it.

A baseline the code has beaten fails the check too, until `npm run ratchet -- --update` (or `npm run lint:prune`)
writes the better figures, so no file can slide back to an old low. Commit the smaller baseline with the change.
Nothing is ever added to a baseline: `npm run ratchet -- --init` only writes a missing one.

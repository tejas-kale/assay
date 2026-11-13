# Rich conversation review — 2026-11-12

Fixed point: `3502d39`. Review covered the SQL foundation and the staged implementation of tickets 04–08.
Two fresh Claude Sonnet 5.5 CLI reviews examined standards and spec separately. Neither changed files. The user
explicitly deferred live Ghostty and installed-app acceptance. Those checks are not claimed as passed.

## Standards: original findings

## Hard violations

1. **`src/cli/runAction.ts` is outside the 90% coverage bar.**
   - It is new, and it opens files, spawns the editor and writes requests.
   - `scripts/coverage-bar.ts:58` adds `plugin/hooks` to the scope but leaves out `src/cli`. `package.json` `test:node` doesn't include it in coverage either.
   - AGENTS.md says "every file meets the lint rules and the 90% coverage bar". `docs/developer/testing.md` ("Coverage") says the bar is "per file". `testing.md` ("Conversation mod") says the helper is tested as a bundled process, so that testing is not measured.
   - Fix: add `src/cli` to the scope, or move the decisions into `src/core`.

2. **`plugin/hooks/conversation-actions.js:7-12,16-25` mixes two error styles in one module.** `actionRequest` throws when `ASSAY_BACKEND` is missing, and `actionMessage` returns failures as strings. `coding-standards.md` says "within one module, errors travel one way". In `src/cli/runAction.ts`, internals throw and the last line converts to `{ok:false}`. That is acceptable, because it is the boundary.

## Judgement-call smells

- **Duplicated Code, expansion state key.**
  - `plugin/hooks/conversation.js:33,40,60` builds `{ plugin: 'assay', key: 'expansion', id }` three times. Add one `expansionRef(id)` and a `readExpansion($, id)` helper.
  - `e.viewport?.columns ?? 80` appears at lines 54, 55, 63 and 79. Compute it once.
- **Duplicated Code, run loading.** `src/core/conversation.ts:47-50` and `src/core/conversationPython.ts:13-16` both do `parseRuns(Object.keys(files)).find(number)`, then load the code text. The "running" row is also built twice, in `conversation.ts` (`runningRow`) and `conversationPython.ts:6-8`, differing only in the input key (`sql` or `code`). Share one `runningRow(call, language)`.
- **Circular import, with a Divergent Change risk.** `conversation.ts` imports `conversationPython.ts`, which imports `callRunNumber` and its types back from `conversation.ts`. Move `resultText`, `callRunNumber` and the types into a leaf module.
- **Repeated Switches / Primitive Obsession.**
  - `'mcp__assay__…'` tool names are string literals in `conversationNotes.ts:305,308,315,316`, `conversation.ts` and `conversation.js:85`. The `mcp__assay__` prefix check at `conversation.js:85` also appears elsewhere in `src/core/rules.ts` and `session.ts`. Use one shared tool-name constant or list.
  - `'edit' | 'rerun'` is a bare string in `runAction.ts:277`, `conversation-actions.js` and `conversation.js`. Give it a type.
- **Data Clumps.** `{ Button, row, expansion, expand }` and `{ Text, Markdown, Button, row, files, expansion, expand }` are passed to every view function. Bundle them into one view context.
- **Message Chains / Mysterious Name.** `conversationNotes.ts:316` is a long literal-array membership test. `pythonConversation`, `conversationNoteRow` and `conversationRow` use inconsistent verb and noun names. `drawNote` also draws thread rows, which makes the name misleading.
- **Middle Man.** `src/core/conversationBundle.ts` only re-exports. It is justified if it is the esbuild entry for the mod. Add a comment saying so.
- **Layout.** `conversation.js:95-118` defines `copyTable` and `submitAction` after `register` but uses them above it. Put them before `register`.


## Standards: disposition

Both substantive findings were corrected: the new request helper now has measured source-process coverage and an
explicit per-file 90% gate, alongside bundled-process tests; missing-backend errors now travel as values through the
pure action module. The runtime import cycle was removed through a shared leaf, and the bundle entry is documented.

The remaining heuristics were assessed rather than applied mechanically. Literal plugin/state/tool names are
part of Claude Code's static validation contract. Separate SQL and Python row construction keeps the models
independent without flag arguments. The view functions receive one explicit options object, each with the fields
it needs. A named state-reference factory would obscure the literals the validator scans. Function placement is
not a documented rule. No speculative registry, shared view-context abstraction or general dispatch framework was added.

## Spec: original findings

I've reported six findings through the findings tool. I read the code and specs only. I ran no tests and changed no files.

The two medium ones:
- **CI install:** `.github/workflows/ci.yml:34` installs a Claude binary with a bare `npm install` pin. It has no lockfile or hash, which goes against the locked-and-hashed rule in `docs/developer/security.md`.
- **Edit/re-run helper:** `src/cli/runAction.ts` takes `{action,file}` on stdin from any process. I found no bash-guard rule for it. Claude's Bash tool could run it and record a run as the user's, which conflicts with the spec's "no tool of Claude's" requirement (story 44).

The four low ones:
- **`revise_note` diff:** it shows every old line as removed and every new line as added, so the user can't see which line changed.
- **Quiet rows:** they hide the engine's error and running state.
- **Buttons:** edit and re-run appear even on runs the helper will refuse.
- **Packaging:** test and type files ship in the packaged plugin copy.

Next: decide whether to fix the two medium findings first.


## Spec: disposition

The CI runner now has a separate pinned, hashed npm lockfile and uses `npm ci --ignore-scripts`; its dependency is
audited. Quiet rows retain running state and pass errors/interruptions to the engine. Refused trusted Python-backed
SQL runs offer no edit/re-run buttons. Replacement diffs preserve common unchanged boundary lines as context.
Packaging excludes native and Node tests and generated declarations, preserving the hand-written state contract.

The Bash finding is within the already accepted PI-1 risk: arbitrary Bash can already forge a request file. The
mod registers only a render hook and exposes no tool or command for its callbacks. A Bash rule cannot establish
an execution boundary; adding one would misstate the documented security model. No new exception is accepted.

An additional loader check found that the state contract must be self-contained. Its import was removed, and the
check now verifies `claude plugin validate --json` reports `success: true` before running mounted tests; the CLI
can otherwise return exit zero alongside validation errors.

## Remaining acceptance

Only live Ghostty rendering, Ayu readability, editor/UI coexistence and installed-app History acceptance remain
deferred to the user. Follow `specs/notes/rich-conversation-acceptance.md`. Automated final-gate results are recorded
in the session handoff and ticket statuses when complete.

## Final verification

The implementation snapshot `58dc74fa7ad973596b8c59c99dfb4271f894fe45` passed `npm run check` in an isolated
worktree with the existing pinned dependencies: 21 native mod tests, 1,057 Node tests, 336 Python tests, typecheck,
lint, loader validation and the per-file 90% line/branch bar. The bundled backend integration suite passed 7/7,
including edit/re-run source provenance and user authorship. Only these Markdown completion records changed
after the tested snapshot; executable code is identical.

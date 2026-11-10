# Coding standards

The standard is Robert C. Martin's *Clean Code*, with two exceptions that win wherever they clash with it:

- **Comments that explain why stay.** A comment says why the code is as it is: a constraint, a gotcha, a decision.
  What the code does belongs in its names.
- **Deep modules stay.** A module with a small interface that hides a lot of complexity (`safePath.ts`, the kernel) is
  the goal, even when the hidden part is long. Split it along its own seams, never into shallow pass-throughs.

## The rules adopted

- Intention-revealing names: a name says what the thing is or does, in the domain's words.
- One responsibility per function and per module.
- Small functions, with few arguments (an options object counts as one).
- Flag arguments split into two functions, one per case.
- Dead code and commented-out code are deleted; git keeps history.
- Command/query separation: a function either changes state or answers a question.
- Within one module, errors travel one way: as values or as exceptions.

## Limits

Lines count without blanks or comments, JSX included. `npm run lint` (ESLint, `eslint.config.js`) and
`npm run lint:py` (ruff, `python/pyproject.toml`) enforce them, and any warning fails.

| Limit | TypeScript | Python |
|---|---|---|
| Function length: 40 lines | `max-lines-per-function` | `PLR0915` (`max-statements`) |
| Parameters: 4 | `max-params` | `PLR0913` (`max-args`) |
| Cognitive complexity: 15 | `sonarjs/cognitive-complexity` | `C901` (McCabe, `max-complexity`) |
| File length: 400 lines | `max-lines` | none: reviewed by hand |
| No duplicated blocks | `sonarjs/no-identical-functions` | none: reviewed by hand |

Beyond the limits, TypeScript runs typescript-eslint's `strictTypeChecked`, eslint-plugin-sonarjs's recommended rules
and, in `src/renderer`, eslint-plugin-react-hooks. Python runs ruff's `E`, `F`, `W`, `I`, `B`, `C90`, `PL`, `SIM`,
`RUF`, `UP` and `N` at line length 120.

Today's code breaks these rules in many places; the baselines record where (`docs/process/testing.md`). Code you
write meets them in full, and code you touch leaves its baseline smaller or the same.

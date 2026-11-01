# Config-repo brief: hide the analysis pane inside the app (slice 1)

Start a session in `~/Code/config`. Goal: when `ANALYSIS_APP` is `1` (set by the desktop app's pty, see `spawnSpec`
in the app repo), the mod never opens its pane, because the app draws Notes and Threads itself. Source read at
`/opt/analysis/hooks/register.tsx` (the repo copy is `claude/analysis/hooks/register.tsx`).

## 1. Read the flag once
The mod reads env with `await $.env.get(NAME).catch(() => undefined)` (`hooks/server.ts:39`, `readForward`).
In `on('session.start', ...)` of `register.tsx`, next to `await readForward($)`, add a module-level
`let isApp = false` and set `isApp = (await $.env.get('ANALYSIS_APP').catch(() => undefined)) === '1'`.

## 2. Call sites of `$.ui.open` (line numbers from the /opt copy; confirm by grepping `ui.open`)
- ~420, `runQuery`, first-query auto-open: wrap the `$.ui.open` in `if (!isApp)`. Keep the `isAutoOpened` update.
- ~741, `adopt` (after `/cd` into an analysis): skip the open when `isApp`.
- ~967, `/an` in the picker case (`!isActive && offer === 'pick'`): when `isApp`, do not open `PICKER`; return
  `{ text: 'The app has its own picker: open or create an analysis there.' }`.
- ~987, `/an [tab]` in an analysis: when `isApp`, still run `startServer` and update the `tab` atom, skip the open,
  and return `{ text: 'The pane lives in the app: Cmd+2 for notes and threads.' }` (not the "Esc returns" text).
- ~1067, `/an trust`: LEAVE OPEN for now. The review card and its y/r keys exist only in the mod pane until slice 4
  builds the app's review view. Flag this to the user as a known gap.
Tools, hooks and file writes are unchanged; only the pane stays closed.

## 3. Test to add in `tests/pane.test.tsx`
Use `fake(on, WORKSPACE)` (`tests/fake.ts`; `state.env` is what `$.env.get` reads) and `start` from `fake.ts`:
```
const ws = fake(on, WORKSPACE); ws.env.ANALYSIS_APP = '1'; await $.session.start(start)
```
Run `/an` with args `''`, `'threads'` and `'data'` (as in the test at "`/an opens the pane, on the tab its argument names`"),
and one `sql` tool call (pattern in `tests/tools.test.ts`). Expect `ws.opens` toEqual `[]` and the `/an` text to match
`/in the app/`. A second test without the env keeps today's behaviour (the existing test already covers it).

## 4. The wrapper
In `claude/bin/claude`, add `-e ANALYSIS_APP` to the `podman run` arguments, beside the other `-e` passes. It forwards
the host value only if set, so the plain terminal is unaffected. NOTE: the session that wrote this could not see
`claude/bin/claude`; find the right place yourself, and check whether the wrapper also strips the environment.

Run the mod's tests (`tests/` in the config repo) before finishing.

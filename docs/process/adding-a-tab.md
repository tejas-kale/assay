# Adding a tab

A tab is one registry entry, one component file and one line in the component map. The panes' tab bars, the
`Ctrl+Shift` shortcut, the palette's Show command, `Ctrl+2` cycling, the markers and Settings > Tabs all read the
registry, so nothing else changes.

1. **Registry entry** in `src/core/tabs.ts`'s `TABS`: `id`, `title`, `pane` (`'notes'` or `'data'`), `shortcut`
   (a free `Key*` code for `Ctrl+Shift`), and, for a data-pane tab with content worth flagging, a `marker` that
   compares two `Seen` snapshots. `tabs.test.ts` fails on a repeated id or key.
2. **Component** in `src/renderer/tabs/<id>.tsx`. It takes its pane's shared props: `NotesTabProps` (the analysis
   state, a search reveal, `onShowRun`) or `DataTabProps` (`pane`: the current run, its header and the pane's
   actions; `DataPaneModel` in `components/DataPane.tsx`).
3. **Map line** in `src/renderer/tabs/index.ts`'s `TAB_VIEWS`. Leaving it out fails the typecheck. Add `label` when
   the tab bar should show more than the title (Threads counts the open ones).

Settings needs nothing: `parseSettings` appends a tab missing from a user's `settings.json` at the end of its pane,
turned on.

## Worked example: a Schema tab in the data pane

```ts
// src/core/tabs.ts, in TABS after trust
{ id: 'schema', title: 'Schema', pane: 'data', shortcut: 'KeyM', marker: (b, a) => b.number !== a.number },
```

```tsx
// src/renderer/tabs/schema.tsx
import { Placeholder } from '../components/DataPane.tsx'
import type { DataTabProps } from './types.ts'

export function Schema({ pane }: Readonly<DataTabProps>) {
  if (!pane.current) return <Placeholder text="No runs yet." />
  return <div className="schema">{pane.header}{/* the run's columns */}</div>
}
```

```ts
// src/renderer/tabs/index.ts
schema: { Component: Schema },
```

Then add its keys to `PANE_KEYS` in `src/core/keymap.ts` if it has any, and run `npm run check`.

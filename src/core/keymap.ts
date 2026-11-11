export type CommandId =
  | 'focus.terminal'
  | 'focus.notes'
  | 'focus.data'
  | 'terminal.zoom'
  | 'palette.open'
  | 'search.open'
  | 'code.run'
  | 'code.edit'
  | 'code.new'
  | 'run.interrupt'
  | 'analysis.new'
  | 'tab.data'
  | 'tab.plots'
  | 'tab.code'
  | 'tab.history'
  | 'tab.steps'
  | 'tab.trust'
  | 'tab.overview'
  | 'tab.notes'
  | 'tab.threads'
  | 'tab.files'
  | 'analysis.close'
  | 'settings.open'
  | 'pin.toggle'
  | 'kernel.restart'
  | 'replay.open'
  | 'analysis.rename'
  | 'shortcuts.show'
  | 'strip.side'
  | 'update.restart'
  | AnalysisSwitch

/** Cmd+1 to Cmd+9: show that analysis in the window's set (core/analysisSet.ts). */
export type AnalysisSwitch = `analysis.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

/** The number an analysis-switch command shows, or undefined for any other command. */
export function analysisNumber(id: CommandId): number | undefined {
  const match = /^analysis\.([1-9])$/.exec(id)
  return match ? Number(match[1]) : undefined
}

/**
 * A shortcut, by physical key `code` (for example `Digit1`) so layouts do not matter. Cmd is implied, unless `ctrl`
 * puts Ctrl in its place: every pane key (focus, tabs, zoom) uses Ctrl, so Cmd is left for analyses and the app.
 */
export type KeySpec = { code: string; shift?: true; ctrl?: true }

export type Command = {
  id: CommandId
  title: string
  accelerator?: KeySpec
}

export const COMMANDS: readonly Command[] = [
  { id: 'focus.terminal', title: 'Focus terminal', accelerator: { code: 'Digit1', ctrl: true } },
  { id: 'focus.notes', title: 'Focus notes and threads', accelerator: { code: 'Digit2', ctrl: true } },
  { id: 'focus.data', title: 'Focus data pane', accelerator: { code: 'Digit3', ctrl: true } },
  { id: 'terminal.zoom', title: 'Zoom terminal / restore panes', accelerator: { code: 'Digit0', ctrl: true } },
  { id: 'palette.open', title: 'Command palette', accelerator: { code: 'KeyP' } },
  { id: 'search.open', title: 'Search everything', accelerator: { code: 'KeyF' } },
  { id: 'code.run', title: 'Run current code, or the selected SQL', accelerator: { code: 'Enter' } },
  { id: 'code.edit', title: 'Edit current code', accelerator: { code: 'KeyE' } },
  { id: 'code.new', title: 'New SQL query' },
  { id: 'run.interrupt', title: 'Interrupt run', accelerator: { code: 'Period' } },
  { id: 'analysis.new', title: 'Open another analysis', accelerator: { code: 'KeyN' } },
  { id: 'analysis.close', title: 'Close analysis', accelerator: { code: 'KeyW' } },
  { id: 'settings.open', title: 'Settings', accelerator: { code: 'Comma' } },
  { id: 'tab.data', title: 'Show Data tab', accelerator: { code: 'KeyD', shift: true, ctrl: true } },
  { id: 'tab.plots', title: 'Show Plots tab', accelerator: { code: 'KeyP', shift: true, ctrl: true } },
  { id: 'tab.code', title: 'Show Code tab', accelerator: { code: 'KeyC', shift: true, ctrl: true } },
  { id: 'tab.history', title: 'Show History tab', accelerator: { code: 'KeyH', shift: true, ctrl: true } },
  { id: 'tab.steps', title: 'Show Steps tab', accelerator: { code: 'KeyS', shift: true, ctrl: true } },
  { id: 'tab.trust', title: 'Show Trust tab', accelerator: { code: 'KeyR', shift: true, ctrl: true } },
  { id: 'tab.overview', title: 'Show Overview tab', accelerator: { code: 'KeyO', shift: true, ctrl: true } },
  { id: 'tab.threads', title: 'Show Threads tab', accelerator: { code: 'KeyT', shift: true, ctrl: true } },
  { id: 'tab.notes', title: 'Show Notes tab', accelerator: { code: 'KeyN', shift: true, ctrl: true } },
  { id: 'tab.files', title: 'Show Files tab', accelerator: { code: 'KeyF', shift: true, ctrl: true } },
  { id: 'shortcuts.show', title: 'Show Shortcuts' },
  { id: 'pin.toggle', title: 'Pin current run' },
  { id: 'kernel.restart', title: 'Restart kernel' },
  { id: 'replay.open', title: 'Replay' },
  { id: 'analysis.rename', title: 'Rename analysis' },
  { id: 'strip.side', title: 'Move analysis strip: bottom / left' },
  { id: 'update.restart', title: 'Restart to update' },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map(n => ({
    id: `analysis.${n}` as const,
    title: `Show analysis ${n}`,
    accelerator: { code: `Digit${n}` },
  })),
]

/** The commands the palette lists: Restart to update only while a downloaded update waits (docs/slice-11.md, 11d). */
export function paletteCommands({ isUpdateReady }: { isUpdateReady: boolean }): readonly Command[] {
  return isUpdateReady ? COMMANDS : COMMANDS.filter(c => c.id !== 'update.restart')
}

/** The parts of Electron's `Input` that matter here. */
export type KeyInput = { key: string; code: string; meta: boolean; shift: boolean; ctrl: boolean; alt: boolean }

/** The command a key press claims, or undefined to let it through to the terminal. */
export function commandForInput(input: KeyInput): CommandId | undefined {
  if (input.alt || input.meta === input.ctrl) return undefined
  return COMMANDS.find(
    c =>
      c.accelerator &&
      c.accelerator.code === input.code &&
      (c.accelerator.shift ?? false) === input.shift &&
      (c.accelerator.ctrl ?? false) === input.ctrl,
  )?.id
}

const KEY_SYMBOLS: Record<string, string> = { Enter: '↩', Comma: ',', Period: '.' }

/** A command's shortcut as the Mac writes it, modifiers in the order ⌃⇧⌘, such as `⇧⌘P` or `⌃⇧C`; empty when it has none. */
export function shortcutLabel(id: CommandId): string {
  const a = COMMANDS.find(c => c.id === id)?.accelerator
  if (!a) return ''
  const key = a.code.replace(/^Key|^Digit/, '')
  return `${a.ctrl ? '⌃' : ''}${a.shift ? '⇧' : ''}${a.ctrl ? '' : '⌘'}${KEY_SYMBOLS[key] ?? key}`
}

/** Single keys inside a pane, for the Show Shortcuts overlay. The panes no longer print them. */
export const PANE_KEYS: { pane: string; keys: [string, string][] }[] = [
  { pane: 'Overview', keys: [['s', 'analysis / system overview'], ['d', 'diff since marked read, on / off'], ['m', 'mark read'], ['j / k', 'scroll'], ['g / G', 'top / bottom'], ['⌃2 again', 'switch to Threads']] },
  {
    pane: 'Threads',
    keys: [['⌃2 again', 'switch to Notes'], ['j / k', 'move'], ['/', 'search'], ['Tab', 'full text in a pop-up'], ['a', 'add'], ['e', 'edit'], ['c', 'close'], ['d', 'delete'], ['J / K', 'reorder'], ['z', 'show / hide closed threads']],
  },
  {
    pane: 'Notes',
    keys: [['⌃2 again', 'switch to Files'], ['j / k', 'move'], ['/', 'search'], ['Enter', 'read note'], ['a', 'add note (⌘Enter saves)'], ['e', 'edit']],
  },
  {
    pane: 'Note reader',
    keys: [['Tab / ⇧Tab', 'next / previous link or citation'], ['Enter', 'follow: note, run in the data pane, or another analysis\'s run in a pop-up'], ['Backspace', 'previous note'], ['j / k', 'scroll'], ['e', 'edit'], ['Esc', 'back to the list']],
  },
  { pane: 'Preview pop-up', keys: [['h j k l  w b', 'move'], ['g / G', 'top / bottom'], ['o', 'original / formatted SQL'], ['Esc / Tab / q', 'close']] },
  { pane: 'Note editor', keys: [['⌘S', 'save'], ['Esc', 'leave (in Vim normal mode)']] },
  {
    pane: 'Data',
    keys: [['h j k l', 'move cell'], ['J / K', 'page'], ['g / G  0 / $', 'first / last'], ['Enter', 'whole row'], ['y', 'copy cell'], [', / .', 'earlier / later run'], ['c', 'its Code'], ['p', 'pin / follow latest'], ['[ / ]', 'previous / next table'], ['s', 'stdout and error']],
  },
  { pane: 'Steps', keys: [['j / k', 'next / previous step'], ['click a box', 'select its step'], ['r', 'run the steps again'], [', / .', 'earlier / later run'], ['c', 'its Code'], ['p', 'pin / follow latest']] },
  { pane: 'Plots', keys: [['j / k', 'next / previous plot'], [', / .', 'earlier / later run'], ['c', 'its Code'], ['p', 'pin / follow latest']] },
  {
    pane: 'Replay',
    keys: [['j / k', 'move'], ['space', 'choose or drop'], ['a', 'all / none'], ['Enter', 'ask to replay'], ['y / n', 'confirm / back'], ['Esc', 'leave']],
  },
  {
    pane: 'Code',
    keys: [['h j k l  w b', 'move'], ['g / G', 'top / bottom'], [', / .', 'earlier / later run'], ['o', 'original / formatted'], ['x', 'expanded SQL of a run with includes'], ['d', 'its Data'], ['i', 'edit'], ['n', 'new SQL query'], ['⌘E', 'edit from anywhere'], ['p', 'pin / follow latest'], ['⌘↩', 're-run as a new run; with SQL selected, run just that (opens in Data)']],
  },
  { pane: 'Code editing', keys: [['Esc', 'leave (in Vim normal mode)'], ['⌘↩', 'run as a new run (a new query opens in Data); with SQL selected, run just that']] },
  {
    pane: 'History',
    keys: [['j / k', 'move'], ['Enter', 'show that run'], ['p', 'pin / follow latest'], ['newest run', 'follow Claude again']],
  },
  { pane: 'Trust', keys: [['J / K  ↑ / ↓', 'choose a proposal'], ['c / Enter', 'check it'], ['t / r', 'trust / reject, once every check passed'], ['l', 'list the proposals again'], ['j / k', 'scroll'], ['g / G', 'top / bottom'], ['⌘↩', 'run the selected SQL (opens in Data)']] },
  {
    pane: 'Files',
    keys: [['j / k', 'move'], ['/', 'search'], ['Enter', 'open: text in Neovim, Mermaid chart in the browser, image preview'], ['Tab', 'preview in a pop-up'], ['r', 'refresh'], ['⌃2 again', 'switch to Overview']],
  },
  {
    pane: 'Search (⌘F)',
    keys: [['↑ / ↓ or Ctrl-N / Ctrl-P', 'move'], ['Enter', 'show it in its tab'], ['Tab', 'preview on / off'], ['Ctrl-D / Ctrl-U', 'scroll preview'], ['Esc', 'close']],
  },
  { pane: 'Picker', keys: [['↑ / ↓ or Ctrl-N / Ctrl-P', 'move'], ['Enter', 'open or create']] },
]

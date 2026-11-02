export type CommandId =
  | 'focus.terminal'
  | 'focus.notes'
  | 'focus.data'
  | 'palette.open'
  | 'code.run'
  | 'code.edit'
  | 'run.interrupt'
  | 'window.new'
  | 'tab.data'
  | 'tab.plots'
  | 'tab.code'
  | 'tab.history'
  | 'tab.trust'
  | 'tab.notes'
  | 'tab.threads'
  | 'tab.files'
  | 'window.close'
  | 'settings.open'
  | 'pin.toggle'
  | 'kernel.restart'
  | 'replay.open'
  | 'shortcuts.show'

/** A Cmd shortcut, by physical key `code` (for example `Digit1`) so layouts do not matter. Cmd is always implied. */
export type KeySpec = { code: string; shift?: true }

export type Command = {
  id: CommandId
  title: string
  accelerator?: KeySpec
}

export const COMMANDS: readonly Command[] = [
  { id: 'focus.terminal', title: 'Focus terminal', accelerator: { code: 'Digit1' } },
  { id: 'focus.notes', title: 'Focus notes and threads', accelerator: { code: 'Digit2' } },
  { id: 'focus.data', title: 'Focus data pane', accelerator: { code: 'Digit3' } },
  { id: 'palette.open', title: 'Command palette', accelerator: { code: 'KeyP' } },
  { id: 'code.run', title: 'Run current code', accelerator: { code: 'Enter' } },
  { id: 'code.edit', title: 'Edit current code', accelerator: { code: 'KeyE' } },
  { id: 'run.interrupt', title: 'Interrupt run', accelerator: { code: 'Period' } },
  { id: 'window.new', title: 'New window', accelerator: { code: 'KeyN' } },
  { id: 'window.close', title: 'Close window', accelerator: { code: 'KeyW' } },
  { id: 'settings.open', title: 'Settings', accelerator: { code: 'Comma' } },
  { id: 'tab.data', title: 'Show Data tab', accelerator: { code: 'KeyD', shift: true } },
  { id: 'tab.plots', title: 'Show Plots tab', accelerator: { code: 'KeyP', shift: true } },
  { id: 'tab.code', title: 'Show Code tab', accelerator: { code: 'KeyC', shift: true } },
  { id: 'tab.history', title: 'Show History tab', accelerator: { code: 'KeyH', shift: true } },
  { id: 'tab.trust', title: 'Show Trust tab', accelerator: { code: 'KeyR', shift: true } },
  { id: 'tab.threads', title: 'Show Threads tab', accelerator: { code: 'KeyT', shift: true } },
  { id: 'tab.notes', title: 'Show Notes tab', accelerator: { code: 'KeyN', shift: true } },
  { id: 'tab.files', title: 'Show Files tab', accelerator: { code: 'KeyF', shift: true } },
  { id: 'shortcuts.show', title: 'Show Shortcuts' },
  { id: 'pin.toggle', title: 'Pin current run' },
  { id: 'kernel.restart', title: 'Restart kernel' },
  { id: 'replay.open', title: 'Replay' },
]

/** The parts of Electron's `Input` that matter here. */
export type KeyInput = { key: string; code: string; meta: boolean; shift: boolean; ctrl: boolean; alt: boolean }

/** The command a key press claims, or undefined to let it through to the terminal. */
export function commandForInput(input: KeyInput): CommandId | undefined {
  if (!input.meta || input.ctrl || input.alt) return undefined
  return COMMANDS.find(
    c => c.accelerator && c.accelerator.code === input.code && (c.accelerator.shift ?? false) === input.shift,
  )?.id
}

const KEY_SYMBOLS: Record<string, string> = { Enter: '↩', Comma: ',', Period: '.' }

/** A command's shortcut as the Mac writes it, such as `⇧⌘P`; empty when it has none. */
export function shortcutLabel(id: CommandId): string {
  const a = COMMANDS.find(c => c.id === id)?.accelerator
  if (!a) return ''
  const key = a.code.replace(/^Key|^Digit/, '')
  return `${a.shift ? '⇧' : ''}⌘${KEY_SYMBOLS[key] ?? key}`
}

/** Single keys inside a pane, for the Show Shortcuts overlay. The panes no longer print them. */
export const PANE_KEYS: { pane: string; keys: [string, string][] }[] = [
  {
    pane: 'Threads',
    keys: [['⌘2 again', 'switch to Notes'], ['j / k', 'move'], ['/', 'search'], ['a', 'add'], ['e', 'edit'], ['c', 'close'], ['d', 'delete'], ['J / K', 'reorder']],
  },
  {
    pane: 'Notes',
    keys: [['⌘2 again', 'switch to Files'], ['j / k', 'move'], ['/', 'search'], ['Enter', 'open file note or read note'], ['a', 'add fact'], ['n', 'new note'], ['e', 'edit'], ['d', 'delete']],
  },
  {
    pane: 'Note reader',
    keys: [['Tab / ⇧Tab', 'next / previous link or citation'], ['Enter', 'follow: note, or run in the data pane'], ['Backspace', 'previous note'], ['j / k', 'scroll'], ['e', 'edit'], ['Esc', 'back to the list']],
  },
  { pane: 'Note editor', keys: [['⌘S', 'save'], ['Esc', 'leave (in Vim normal mode)']] },
  {
    pane: 'Data',
    keys: [['h j k l', 'move cell'], ['J / K', 'page'], ['g / G  0 / $', 'first / last'], ['Enter', 'whole row'], ['y', 'copy cell'], ['c', 'its Code'], ['p', 'pin / follow latest'], ['[ / ]', 'previous / next table'], ['s', 'stdout and error']],
  },
  { pane: 'Plots', keys: [['j / k', 'next / previous plot'], ['c', 'its Code'], ['p', 'pin / follow latest']] },
  {
    pane: 'Replay',
    keys: [['j / k', 'move'], ['space', 'choose or drop'], ['a', 'all / none'], ['Enter', 'ask to replay'], ['y / n', 'confirm / back'], ['Esc', 'leave']],
  },
  {
    pane: 'Code',
    keys: [['h j k l  w b', 'move'], ['g / G', 'top / bottom'], ['o', 'original / formatted'], ['d', 'its Data'], ['i', 'edit'], ['⌘E', 'edit from anywhere'], ['p', 'pin / follow latest'], ['⌘↩', 're-run as a new run']],
  },
  { pane: 'Code editing', keys: [['Esc', 'leave (in Vim normal mode)'], ['⌘↩', 'run as a new run']] },
  {
    pane: 'History',
    keys: [['j / k', 'move'], ['Enter', 'show that run'], ['p', 'pin / follow latest'], ['newest run', 'follow Claude again']],
  },
  { pane: 'Trust', keys: [['j / k', 'scroll'], ['g / G', 'top / bottom']] },
  {
    pane: 'Files',
    keys: [['j / k', 'move'], ['/', 'search'], ['Enter', 'open: text in Neovim, image preview'], ['r', 'refresh'], ['⌘2 again', 'switch to Threads']],
  },
  { pane: 'Picker', keys: [['↑ / ↓ or Ctrl-N / Ctrl-P', 'move'], ['Enter', 'open or create']] },
]

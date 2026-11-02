export type CommandId =
  | 'focus.terminal'
  | 'focus.notes'
  | 'focus.data'
  | 'palette.open'
  | 'code.run'
  | 'window.new'
  | 'tab.data'
  | 'tab.plots'
  | 'tab.code'
  | 'tab.history'
  | 'tab.notes'
  | 'tab.threads'
  | 'window.close'
  | 'settings.open'
  | 'pin.toggle'
  | 'kernel.restart'
  | 'replay.open'

/** A Cmd shortcut, by physical key `code` (for example `Digit1`) so layouts do not matter. Cmd is always implied. */
export type KeySpec = { code: string; shift?: true }

export type Command = {
  id: CommandId
  title: string
  accelerator?: KeySpec
  /** Set while the command's slice is not built: the palette lists it and runs nothing but this message. */
  unavailable?: string
}

export const COMMANDS: readonly Command[] = [
  { id: 'focus.terminal', title: 'Focus terminal', accelerator: { code: 'Digit1' } },
  { id: 'focus.notes', title: 'Focus notes and threads', accelerator: { code: 'Digit2' } },
  { id: 'focus.data', title: 'Focus data pane', accelerator: { code: 'Digit3' } },
  { id: 'palette.open', title: 'Command palette', accelerator: { code: 'KeyP' } },
  { id: 'code.run', title: 'Run current code', accelerator: { code: 'Enter' } },
  { id: 'window.new', title: 'New window', accelerator: { code: 'KeyN' } },
  { id: 'window.close', title: 'Close window', accelerator: { code: 'KeyW' } },
  { id: 'settings.open', title: 'Settings', accelerator: { code: 'Comma' } },
  { id: 'tab.data', title: 'Show Data tab', accelerator: { code: 'KeyD', shift: true } },
  { id: 'tab.plots', title: 'Show Plots tab', accelerator: { code: 'KeyP', shift: true } },
  { id: 'tab.code', title: 'Show Code tab', accelerator: { code: 'KeyC', shift: true } },
  { id: 'tab.history', title: 'Show History tab', accelerator: { code: 'KeyH', shift: true } },
  { id: 'tab.notes', title: 'Show Notes tab' },
  { id: 'tab.threads', title: 'Show Threads tab' },
  { id: 'pin.toggle', title: 'Pin current run', unavailable: 'Pin is not available until slice 2' },
  { id: 'kernel.restart', title: 'Restart kernel', unavailable: 'Restart kernel is not available until slice 3' },
  { id: 'replay.open', title: 'Replay', unavailable: 'Replay is not available until slice 3' },
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

const KEY_SYMBOLS: Record<string, string> = { Enter: '↩', Comma: ',' }

/** A command's shortcut as the Mac writes it, such as `⇧⌘P`; empty when it has none. */
export function shortcutLabel(id: CommandId): string {
  const a = COMMANDS.find(c => c.id === id)?.accelerator
  if (!a) return ''
  const key = a.code.replace(/^Key|^Digit/, '')
  return `${a.shift ? '⇧' : ''}⌘${KEY_SYMBOLS[key] ?? key}`
}

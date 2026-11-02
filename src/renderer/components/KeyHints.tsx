import { shortcutLabel } from '../../core/keymap.ts'
import type { CommandId } from '../../core/keymap.ts'

const GLOBAL: [CommandId, string][] = [
  ['palette.open', 'Palette'],
  ['window.new', 'New window'],
  ['window.close', 'Close'],
  ['settings.open', 'Settings'],
]

/** One pane's hint, shown in its top-right corner while left Cmd is held. */
export const PaneHint = ({ children }: { children: string }) => (
  <span className="key-hint" aria-hidden="true">
    {children}
  </span>
)

/** The shortcuts that work from anywhere, shown at the bottom of the window while left Cmd is held. */
export function GlobalHints() {
  return (
    <div className="key-hints" aria-hidden="true">
      {GLOBAL.map(([id, label]) => (
        <span key={id}>
          <b>{shortcutLabel(id)}</b> {label}
        </span>
      ))}
    </div>
  )
}

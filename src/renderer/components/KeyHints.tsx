import { useEffect, useRef } from 'react'

import { COMMANDS, PANE_KEYS, shortcutLabel } from '../../core/keymap.ts'
import type { CommandId } from '../../core/keymap.ts'

const GLOBAL: [CommandId, string][] = [
  ['palette.open', 'Palette'],
  ['search.open', 'Search'],
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

const OVERLAY_MS = 6000

/** Every shortcut at once, from the palette's Show Shortcuts. Goes after a few seconds, or on any key or click. */
export function ShortcutsOverlay({ onDone }: { onDone: () => void }) {
  // A ref, so a parent re-render (a new onDone) does not restart the timer.
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    const done = () => doneRef.current()
    const timer = setTimeout(done, OVERLAY_MS)
    // Added after this frame, so the Enter that ran the command does not dismiss it.
    const frame = requestAnimationFrame(() => {
      window.addEventListener('keydown', done, true)
      window.addEventListener('mousedown', done, true)
    })
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', done, true)
      window.removeEventListener('mousedown', done, true)
    }
  }, [])

  const global = COMMANDS.filter(c => c.accelerator)
  return (
    <div className="shortcuts" role="dialog" aria-label="Shortcuts">
      <section>
        <h2>Anywhere</h2>
        {global.map(c => (
          <div key={c.id} className="shortcut">
            <b>{shortcutLabel(c.id)}</b>
            <span>{c.title}</span>
          </div>
        ))}
      </section>
      {PANE_KEYS.map(group => (
        <section key={group.pane}>
          <h2>{group.pane}</h2>
          {group.keys.map(([key, what]) => (
            <div key={key} className="shortcut">
              <b>{key}</b>
              <span>{what}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

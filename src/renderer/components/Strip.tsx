// The analysis strip along the bottom of the window: one entry per open analysis with Claude's state and any run in
// progress. Its own view (main loads the page with #strip). Numbers and titles show while left Cmd is held.
import { useEffect, useState } from 'react'

import type { HoldKind } from '../../core/cmdHold.ts'
import type { StripEntry } from '../../core/strip.ts'

const STATE_LABEL: Record<StripEntry['state'], string> = {
  working: 'Claude working',
  waiting: 'Claude waiting for you',
  idle: 'Claude idle',
  ended: 'Session ended',
}

export function Strip() {
  const [entries, setEntries] = useState<StripEntry[]>([])
  const [hints, setHints] = useState<HoldKind>()
  useEffect(() => {
    const stops = [window.app.onStripEntries(setEntries), window.app.onHints(setHints)]
    return () => stops.forEach(stop => stop())
  }, [])
  const named = hints === 'cmd'
  return (
    <nav className="strip" aria-label="Open analyses">
      {entries.map(entry => (
        <button
          key={entry.number}
          className={`strip-entry${entry.current ? ' current' : ''}`}
          title={`⌘${entry.number} ${entry.title}: ${STATE_LABEL[entry.state]}`}
          onClick={() => void window.app.showAnalysis(entry.number)}
        >
          <span className={`strip-dot ${entry.state}`} aria-label={STATE_LABEL[entry.state]} />
          {named && (
            <span className="strip-name">
              <b>⌘{entry.number}</b> {entry.title}
            </span>
          )}
          {entry.run && <span className="strip-run">#{entry.run.number} {entry.run.duration}</span>}
        </button>
      ))}
    </nav>
  )
}

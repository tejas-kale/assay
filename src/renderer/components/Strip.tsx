// The analysis strip: one entry per open analysis with its title, Claude's state and any run in progress. Its own
// view (main loads the page with #strip), along the bottom or down the left with the text turned to read upwards
// (the palette's Move analysis strip).
// Holding left Cmd adds each entry's Cmd+number.
import { useEffect, useState } from 'react'

import type { HoldKind } from '../../core/cmdHold.ts'
import type { StripView } from '../../shared/ipc.ts'

export function Strip() {
  const [view, setView] = useState<StripView>({ side: 'bottom', entries: [] })
  const [hints, setHints] = useState<HoldKind>()
  useEffect(() => {
    const stops = [window.app.onStripEntries(setView), window.app.onHints(setHints)]
    return () => stops.forEach(stop => stop())
  }, [])
  return (
    <nav className={`strip ${view.side}`} aria-label="Open analyses">
      {view.entries.map(entry => (
        <button
          key={entry.number}
          className={`strip-entry${entry.current ? ' current' : ''}`}
          title={`⌘${entry.number}  ${entry.title}`}
          onClick={() => void window.app.showAnalysis(entry.number)}
        >
          <span className={`strip-dot ${entry.state}`} aria-hidden="true" />
          {hints === 'cmd' && <b className="strip-key">⌘{entry.number}</b>}
          <span className="strip-title">{entry.label}</span>
          {entry.stateText && <span className={`strip-state ${entry.state}`}>{entry.stateText}</span>}
          {entry.run && <span className="strip-run">#{entry.run.number} {entry.run.duration}</span>}
        </button>
      ))}
    </nav>
  )
}

// The analysis strip: one entry per open analysis with its title, Claude's state and any run in progress. Its own
// view (main loads the page with #strip), along the bottom or down the left with the text turned to read upwards
// (Settings > Strip, or the palette's Move analysis strip). Settings > Strip also picks what each entry shows.
// Holding left Cmd adds each entry's Cmd+number.
import { useEffect, useState } from 'react'

import type { HoldKind } from '../../core/cmdHold.ts'
import type { StripEntry } from '../../core/strip.ts'
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
          {entry.state && <StateIcon state={entry.state} />}
          {(entry.key !== undefined || hints === 'cmd') && <b className="strip-key">⌘{entry.number}</b>}
          {entry.label !== undefined && <span className="strip-title">{entry.label}</span>}
          {entry.run && <span className="strip-run">#{entry.run.number} {entry.run.duration}</span>}
        </button>
      ))}
    </nav>
  )
}

type State = NonNullable<StripEntry['state']>

const STATE_NAME: Record<State, string> = {
  idle: 'idle',
  working: 'working',
  waiting: 'waiting for you',
  ended: 'session ended',
}

/** Claude's state as an icon, with no visible words: empty circle, pulsing orange dot, or a small white hand. */
function StateIcon({ state }: { state: State }) {
  if (state !== 'waiting') return <span className={`strip-dot ${state}`} role="img" aria-label={STATE_NAME[state]} />
  // A raised hand: drawn once thick in the outline colour, then filled white on top, so it reads on light panels too.
  const hand = (
    <>
      <rect x="3.5" y="1.5" width="2" height="8" rx="1" />
      <rect x="6" y="0.5" width="2" height="8" rx="1" />
      <rect x="8.5" y="1" width="2" height="8" rx="1" />
      <rect x="11" y="2.5" width="2" height="7" rx="1" />
      <rect x="1.5" y="8" width="2" height="5" rx="1" transform="rotate(-40 2.5 10.5)" />
      <rect x="3.5" y="6.5" width="9.5" height="9" rx="3" />
    </>
  )
  return (
    <svg className="strip-hand" viewBox="-1 -1 16 18" role="img" aria-label={STATE_NAME.waiting}>
      <g className="outline">{hand}</g>
      <g className="fill">{hand}</g>
    </svg>
  )
}

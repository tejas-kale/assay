// Settings > Tabs and Settings > Strip (docs/slice-11.md, 11e). Each change is saved at once and every analysis follows.
import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'

import type { StripPrefs, StripShow } from '../../core/strip.ts'
import { moveTab, setTabOn, tabSpec } from '../../core/tabs.ts'
import type { Pane, TabId, TabPrefs } from '../../core/tabs.ts'

const PANE_LABEL: Record<Pane, string> = { notes: 'Notes pane', data: 'Data pane' }

/** Alt+↑ / Alt+↓ on a tab's row moves it; the row's buttons do the same. */
function moveKey(e: KeyboardEvent): 1 | -1 | undefined {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return undefined
  e.preventDefault()
  return e.key === 'ArrowUp' ? -1 : 1
}

function TabRow(props: Readonly<{ id: TabId; on: boolean; first: boolean; last: boolean; onChange: (change: (prefs: TabPrefs) => TabPrefs) => void }>) {
  const { id, on, onChange } = props
  const move = (delta: 1 | -1) => {
    onChange(prefs => moveTab(prefs, id, delta))
  }
  const focusAfterMove = (row: HTMLElement | null) => {
    requestAnimationFrame(() => {
      row?.querySelector('input')?.focus()
    })
  }
  return (
    <li
      className="settings-tab"
      onKeyDown={e => {
        const delta = moveKey(e)
        if (delta === undefined) return
        move(delta)
        focusAfterMove(e.currentTarget)
      }}
    >
      <label>
        <input type="checkbox" checked={on} onChange={e => {
            const checked = e.target.checked
            onChange(prefs => setTabOn(prefs, id, checked))
          }} />
        {tabSpec(id).title}
      </label>
      <button type="button" aria-label={`Move ${tabSpec(id).title} up`} disabled={props.first} onClick={() => {
        move(-1)
      }}>
        ↑
      </button>
      <button type="button" aria-label={`Move ${tabSpec(id).title} down`} disabled={props.last} onClick={() => {
        move(1)
      }}>
        ↓
      </button>
    </li>
  )
}

/**
 * Saves `next` and keeps it as the base of the following change, so a second click before the first save comes back
 * builds on the first rather than undoing it. A broadcast from main replaces the base.
 */
function useLatest<T>(saved: T, save: (next: T) => void): (update: (current: T) => T) => void {
  const latest = useRef(saved)
  useEffect(() => {
    latest.current = saved
  }, [saved])
  return update => {
    latest.current = update(latest.current)
    save(latest.current)
  }
}

export function TabSettings({ tabs }: Readonly<{ tabs: TabPrefs }>) {
  const change = useLatest(tabs, next => {
    void window.app.settings.setTabs(next)
  })
  return (
    <section className="settings-section">
      <h2>Tabs</h2>
      <div className="settings-panes">
        {(['notes', 'data'] as const).map(pane => (
          <div key={pane}>
            <div className="dim">{PANE_LABEL[pane]}</div>
            <ul className="settings-tabs">
              {tabs[pane].map((tab, i) => (
                <TabRow key={tab.id} id={tab.id} on={tab.on} first={i === 0} last={i === tabs[pane].length - 1} onChange={change} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="hint">Alt+↑ / Alt+↓ moves the focused tab. A pane with every tab off is hidden.</div>
    </section>
  )
}

const SHOW_LABEL: Record<keyof StripShow, string> = { title: 'Title', state: 'Claude state', run: 'Run in progress', number: 'Number (⌘1…⌘9)' }

export function StripSettings({ strip }: Readonly<{ strip: StripPrefs }>) {
  const change = useLatest(strip, next => {
    void window.app.settings.setStrip(next)
  })
  return (
    <section className="settings-section">
      <h2>Analysis strip</h2>
      <div className="settings-row" role="radiogroup" aria-label="Strip side">
        {(['bottom', 'left'] as const).map(side => (
          <label key={side}>
            <input type="radio" name="strip-side" checked={strip.side === side} onChange={() => {
                change(s => ({ ...s, side }))
              }} />
            {side === 'bottom' ? 'Bottom' : 'Left'}
          </label>
        ))}
      </div>
      <div className="settings-row">
        {(Object.keys(SHOW_LABEL) as (keyof StripShow)[]).map(part => (
          <label key={part}>
            <input type="checkbox" checked={strip.show[part]} onChange={e => {
                const on = e.target.checked
                change(s => ({ ...s, show: { ...s.show, [part]: on } }))
              }} />
            {SHOW_LABEL[part]}
          </label>
        ))}
      </div>
      <label>
        <input type="checkbox" checked={strip.autoHide} onChange={e => {
            const on = e.target.checked
            change(s => ({ ...s, autoHide: on }))
          }} />
        Hide the strip while one analysis is open
      </label>
    </section>
  )
}

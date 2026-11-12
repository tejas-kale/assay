// Carries out the effects a command's plan lists (core/appCommands.ts) on the window's state.
import { cycledTab } from '../../../core/appCommands.ts'
import type { Effect, WindowCall } from '../../../core/appCommands.ts'
import type { TabPrefs } from '../../../core/tabs.ts'
import type { Navigation, Overlays } from './useAppWindow.ts'

type Surface = Navigation & Overlays & { showToast: (text: string) => void; tabs: TabPrefs }
type Handlers = { [K in Effect['type']]: (effect: Extract<Effect, { type: K }>, s: Surface) => void }

const WINDOW_CALLS: Record<WindowCall, () => Promise<unknown>> = {
  'new-window': () => window.app.newWindow(),
  'close-window': () => window.app.closeWindow(),
  'toggle-strip-side': () => window.app.toggleStripSide(),
  'restart-update': () => window.app.update.restart(),
}

const HANDLERS: Handlers = {
  toast: (e, s) => {
    s.showToast(e.text)
  },
  'notes-tab': (e, s) => {
    s.setNotesTab(e.tab)
  },
  'data-tab': (e, s) => {
    s.setDataTab(e.tab)
  },
  'cycle-tab': (e, s) => {
    if (e.pane === 'notes') s.setNotesTab(tab => cycledTab(s.tabs, 'notes', tab))
    else s.setDataTab(tab => cycledTab(s.tabs, 'data', tab))
  },
  focus: (e, s) => {
    if (e.pane !== 'terminal') s.setZoomed(false)
    s.setFocusRequest({ pane: e.pane, n: s.nextRequest() })
  },
  'toggle-zoom': (_, s) => {
    s.setZoomed(z => !z)
  },
  unzoom: (_, s) => {
    s.setZoomed(false)
  },
  'show-shortcuts': (_, s) => {
    s.setShortcuts(n => n + 1)
  },
  palette: (e, s) => {
    s.setPalette(e.value)
  },
  search: (e, s) => {
    s.setSearch(e.value)
  },
  settings: (e, s) => {
    s.setSettingsOpen(e.value)
  },
  'focus-picker': (_, s) => {
    s.setPickerFocus(n => n + 1)
  },
  'data-command': (e, s) => {
    s.setDataCommand({ id: e.id, n: s.nextRequest() })
  },
  'show-run': (e, s) => {
    s.setDataCommand({ id: 'run.show', number: e.number, n: s.nextRequest() })
  },
  reveal: (e, s) => {
    s.setReveal({ target: e.target, n: s.nextRequest() })
  },
  rename: (_, s) => {
    s.setRenaming(true)
  },
  window: e => {
    void WINDOW_CALLS[e.call]()
  },
  'show-analysis': e => {
    void window.app.showAnalysis(e.number)
  },
}

export function applyEffects(effects: readonly Effect[], surface: Surface) {
  for (const effect of effects) {
    // TypeScript cannot see that the handler under `effect.type` takes exactly this effect.
    const handle = HANDLERS[effect.type] as (effect: Effect, s: Surface) => void
    handle(effect, surface)
  }
}

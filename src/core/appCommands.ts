// What a command does in the app window, as a plan: a list of effects and whether the plan moved the focus itself.
// The window carries the effects out (renderer/components/app/appEffects.ts); deciding them here keeps the rules
// (which command needs an analysis, which tab is off, where the focus goes back to) under test.
import { analysisNumber, tabAction } from './keymap.ts'
import type { CommandId } from './keymap.ts'
import type { SearchTarget } from './search.ts'
import { hitTab, isTabOn, nextTab, shownTab, tabOffText } from './tabs.ts'
import type { Pane, TabId, TabIdIn, TabPrefs } from './tabs.ts'

export type PaneName = 'terminal' | Pane

/** An overlay (the palette, the search, Settings) and the pane the focus goes back to when it closes. */
export type Overlay = { returnTo: PaneName | undefined }

/** The commands the data pane carries out. */
export type DataCommandId = Extract<CommandId, 'pin.toggle' | 'code.edit' | 'code.new' | 'code.run' | 'run.interrupt' | 'kernel.restart' | 'replay.open'>

export type WindowCall = 'new-window' | 'close-window' | 'toggle-strip-side' | 'restart-update'

export type Effect =
  | { type: 'toast'; text: string }
  | { type: 'notes-tab'; tab: TabIdIn<'notes'> }
  | { type: 'data-tab'; tab: TabIdIn<'data'> }
  /** Show the pane's next tab that is on. */
  | { type: 'cycle-tab'; pane: Pane }
  | { type: 'focus'; pane: PaneName }
  | { type: 'toggle-zoom' }
  | { type: 'unzoom' }
  | { type: 'show-shortcuts' }
  | { type: 'palette'; value: Overlay | undefined }
  | { type: 'search'; value: Overlay | undefined }
  | { type: 'settings'; value: Overlay | undefined }
  /** Focus the analysis picker. */
  | { type: 'focus-picker' }
  | { type: 'data-command'; id: DataCommandId }
  | { type: 'show-run'; number: number }
  | { type: 'reveal'; target: SearchTarget }
  | { type: 'rename' }
  | { type: 'window'; call: WindowCall }
  | { type: 'show-analysis'; number: number }

export type CommandPlan = { effects: Effect[]; movedFocus: boolean }

/** What a plan needs to know about the window when the command comes. */
export type CommandContext = {
  tabs: TabPrefs
  /** An analysis is open (not the picker or the loading screen). */
  inWorkspace: boolean
  /** A Python run is running in the open analysis. */
  pythonRunning: boolean
  /** The pane the keyboard focus is in. */
  activePane: PaneName | undefined
  palette: Overlay | undefined
  search: Overlay | undefined
  settings: Overlay | undefined
  /** Settings has no analyses folder yet, so it must stay on top. */
  needsFolder: boolean
}

type Planner = (ctx: CommandContext) => CommandPlan

const plan = (movedFocus: boolean, ...effects: Effect[]): CommandPlan => ({ effects, movedFocus })
const toast = (text: string): Effect => ({ type: 'toast', text })
const focus = (pane: PaneName): Effect => ({ type: 'focus', pane })
const NEEDS_ANALYSIS = 'Open an analysis first.'

/** Back to where an overlay came from: its pane, or the picker. */
export const restoreFocus = (returnTo: PaneName | undefined): Effect => (returnTo ? focus(returnTo) : { type: 'focus-picker' })

/** The tab after `chosen` that is on, in the user's order; `chosen` when the pane has no other. */
export function cycledTab<P extends Pane>(prefs: TabPrefs, pane: P, chosen: TabIdIn<P>): TabIdIn<P> {
  const shown = shownTab(prefs, pane, chosen) ?? chosen
  return (nextTab(prefs, pane, shown) ?? chosen) as TabIdIn<P>
}

/** A request for a tab that is off becomes the toast saying so; otherwise `effects` as they are. */
export function guardTab(prefs: TabPrefs, tab: TabId, effects: Effect[]): Effect[] {
  return isTabOn(prefs, tab) ? effects : [toast(tabOffText(tab))]
}

/** A new trust review shows the Trust tab, or says it is off. */
export const showReviewEffects = (prefs: TabPrefs): Effect[] => guardTab(prefs, 'trust', [{ type: 'data-tab', tab: 'trust' }])

const NOTES_TAB_OF_HIT: Record<'thread' | 'file' | 'note', TabIdIn<'notes'>> = { thread: 'threads', file: 'files', note: 'notes' }

/** What choosing a search hit does: show it in its own tab, a run in the data pane and the rest in the notes pane. */
export function hitEffects(target: SearchTarget, prefs: TabPrefs): Effect[] {
  const close: Effect = { type: 'search', value: undefined }
  if (!isTabOn(prefs, hitTab(target.kind))) return [close, toast(tabOffText(hitTab(target.kind)))]
  if (target.kind === 'run') return [close, { type: 'show-run', number: target.number }, focus('data')]
  return [close, { type: 'notes-tab', tab: NOTES_TAB_OF_HIT[target.kind] }, { type: 'reveal', target }, focus('notes')]
}

/** Closing Settings: the focus goes back to where it was opened from. */
export const closeSettingsEffects = (settings: Overlay | undefined): Effect[] => [{ type: 'settings', value: undefined }, restoreFocus(settings?.returnTo)]

/** Closing the search: the focus goes back to its pane, if it had one. */
export function closeSearchEffects(search: Overlay | undefined): Effect[] {
  const returnTo = search?.returnTo
  return [{ type: 'search', value: undefined }, ...(returnTo ? [focus(returnTo)] : [])]
}

/** Closing the palette: with `restore`, the focus goes back to where it was opened from. */
export function closePaletteEffects(palette: Overlay | undefined, restore: boolean): Effect[] {
  const close: Effect = { type: 'palette', value: undefined }
  return restore ? [close, restoreFocus(palette?.returnTo)] : [close]
}

const needingAnalysis = (planner: Planner): Planner => ctx => (ctx.inWorkspace ? planner(ctx) : plan(false, toast(NEEDS_ANALYSIS)))

/** `focus.notes` and `focus.data`: pressed again inside the pane, they cycle through its tabs. */
const focusPane = (pane: Pane): Planner => ctx =>
  ctx.activePane === pane ? plan(true, { type: 'cycle-tab', pane }, focus(pane)) : plan(true, focus(pane))

const openSettings: Planner = ctx => {
  // Settings takes the place of the palette or the search, and their way back.
  const closing: Effect[] = [
    { type: 'palette', value: undefined },
    { type: 'search', value: undefined },
  ]
  if (ctx.settings) return plan(true, ...closing)
  const from = ctx.palette ?? ctx.search
  return plan(true, ...closing, { type: 'settings', value: { returnTo: from ? from.returnTo : ctx.activePane } })
}

const togglePalette: Planner = ctx => {
  // Settings is on top, and without a folder it must stay there.
  if (ctx.settings || ctx.needsFolder) return plan(true)
  if (!ctx.palette) {
    // Over the search, the palette takes its place and its way back.
    const returnTo = ctx.search ? ctx.search.returnTo : ctx.activePane
    return plan(true, { type: 'search', value: undefined }, { type: 'palette', value: { returnTo } })
  }
  // Toggle off: give focus back to where the palette came from.
  return plan(true, { type: 'palette', value: undefined }, restoreFocus(ctx.palette.returnTo))
}

const toggleSearch: Planner = ctx => {
  if (ctx.settings) return plan(true)
  if (!ctx.inWorkspace) return plan(false, toast(NEEDS_ANALYSIS))
  if (ctx.search) {
    const { returnTo } = ctx.search
    return plan(true, { type: 'search', value: undefined }, ...(returnTo ? [focus(returnTo)] : []))
  }
  // From the palette, the way back is the palette's.
  const returnTo = ctx.palette ? ctx.palette.returnTo : ctx.activePane
  return plan(true, { type: 'palette', value: undefined }, { type: 'search', value: { returnTo } })
}

const dataCommand = (id: DataCommandId): Effect => ({ type: 'data-command', id })

const interrupt: Planner = ctx =>
  ctx.pythonRunning ? plan(true, dataCommand('run.interrupt'), focus('data')) : plan(false, toast('Nothing is running.'))

const windowCall = (call: WindowCall): Planner => () => plan(false, { type: 'window', call })

const PLANNERS: Partial<Record<CommandId, Planner>> = {
  'focus.terminal': () => plan(true, focus('terminal')),
  'terminal.zoom': ctx => (ctx.inWorkspace ? plan(true, { type: 'toggle-zoom' }, focus('terminal')) : plan(false)),
  'focus.notes': focusPane('notes'),
  'focus.data': focusPane('data'),
  'shortcuts.show': () => plan(false, { type: 'show-shortcuts' }),
  'settings.open': openSettings,
  'palette.open': togglePalette,
  'search.open': toggleSearch,
  'code.run': () => plan(false, dataCommand('code.run')),
  'pin.toggle': () => plan(false, dataCommand('pin.toggle')),
  'run.interrupt': interrupt,
  // The pane shows its own prompt or view and takes the keys: focus must be there for y, n and the list keys.
  'kernel.restart': needingAnalysis(() => plan(true, dataCommand('kernel.restart'), focus('data'))),
  'replay.open': needingAnalysis(() => plan(true, dataCommand('replay.open'), focus('data'))),
  'analysis.rename': needingAnalysis(() => plan(true, { type: 'rename' })),
  // The pane switches to Code and focuses the editor itself once it has the run's text.
  'code.edit': () => plan(true, { type: 'unzoom' }, dataCommand('code.edit')),
  'code.new': () => plan(true, { type: 'unzoom' }, dataCommand('code.new')),
  'analysis.new': windowCall('new-window'),
  'analysis.close': windowCall('close-window'),
  'strip.side': windowCall('toggle-strip-side'),
  'update.restart': windowCall('restart-update'),
}

/** What the command `id` does, given the window as it is. */
export function planCommand(id: CommandId, ctx: CommandContext): CommandPlan {
  const tab = tabAction(id, ctx.tabs)
  if (tab?.type === 'toast') return plan(false, toast(tab.text))
  if (tab?.type === 'show') {
    const show: Effect = tab.pane === 'notes' ? { type: 'notes-tab', tab: tab.tab as TabIdIn<'notes'> } : { type: 'data-tab', tab: tab.tab as TabIdIn<'data'> }
    return plan(true, show, focus(tab.pane))
  }
  const planner = Object.hasOwn(PLANNERS, id) ? PLANNERS[id] : undefined
  if (planner) return planner(ctx)
  // Show analysis N, from the palette; the keys go straight to main.
  const number = analysisNumber(id)
  return plan(false, ...(number === undefined ? [] : [{ type: 'show-analysis', number } satisfies Effect]))
}

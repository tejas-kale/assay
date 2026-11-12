// What the analysis strip at the bottom of the window shows for each analysis. Pure: main gathers the facts.
import type { ClaudeState } from './claudeState.ts'

export type StripFacts = {
  /** Its Cmd+number, from 1. */
  number: number
  title: string
  /** What the hooks last recorded. */
  claude: ClaudeState
  /** False once the analysis's Claude session has exited. */
  sessionLive: boolean
  /** The run `.assay/runs.json` says is running. */
  running: { number: number; startedAt: number } | undefined
  /** The analysis the window shows. */
  current: boolean
}

export type StripSide = 'bottom' | 'left'
/** Which parts of an entry the strip shows. */
export type StripShow = { title: boolean; state: boolean; run: boolean; number: boolean }
/** settings.json's `strip`: where it sits, what each entry shows, and whether it hides while one analysis is open. */
export type StripPrefs = { side: StripSide; show: StripShow; autoHide: boolean }

export const DEFAULT_STRIP: StripPrefs = { side: 'bottom', show: { title: true, state: true, run: true, number: false }, autoHide: false }

const field = (object: unknown, key: string): unknown => (object !== null && typeof object === 'object' ? Reflect.get(object, key) : undefined)
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

/** settings.json's `strip`, each part falling back to its default when missing or malformed. */
export function parseStripPrefs(raw: unknown): StripPrefs {
  const show = field(raw, 'show')
  const d = DEFAULT_STRIP.show
  return {
    side: field(raw, 'side') === 'left' ? 'left' : 'bottom',
    show: { title: flag(field(show, 'title'), d.title), state: flag(field(show, 'state'), d.state), run: flag(field(show, 'run'), d.run), number: flag(field(show, 'number'), d.number) },
    autoHide: flag(field(raw, 'autoHide'), DEFAULT_STRIP.autoHide),
  }
}

/** False while auto-hide is on and the window holds at most one analysis. */
export const isStripShown = (prefs: StripPrefs, openCount: number): boolean => !prefs.autoHide || openCount > 1

export type StripEntry = {
  number: number
  /** The full title, for the tooltip. */
  title: string
  /** The title cut to TITLE_CHARS, when the strip shows titles. */
  label?: string
  /** When the strip shows Claude's state: by its icon alone, never in words (empty circle idle, pulsing orange dot working, white hand waiting). */
  state?: ClaudeState | 'ended'
  current: boolean
  /** When the strip shows runs: the one in progress. */
  run?: { number: number; duration: string }
  /** When the strip shows numbers: its Cmd+number, such as `⌘2`. */
  key?: string
}

export function stripEntry(facts: StripFacts, nowMs: number, show: StripShow): StripEntry {
  const entry: StripEntry = { number: facts.number, title: facts.title, current: facts.current }
  if (show.title) entry.label = shortTitle(facts.title, TITLE_CHARS)
  if (show.state) entry.state = facts.sessionLive ? facts.claude : 'ended'
  if (show.run && facts.running) entry.run = { number: facts.running.number, duration: runDuration(facts.running.startedAt, nowMs) }
  if (show.number) entry.key = `⌘${String(facts.number)}`
  return entry
}

/** How much of a title the strip shows: room for four entries across the bottom of a laptop screen. */
export const TITLE_CHARS = 24

/** `title` in at most `max` characters: cut at the last word break in the second half if there is one, then `…`. */
export function shortTitle(title: string, max: number): string {
  const trimmed = title.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "0:07", "2:05", "1:02:03". */
export function runDuration(startedAtMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${String(minutes)}:${pad(seconds)}`
}

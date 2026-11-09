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

export type StripEntry = {
  number: number
  title: string
  /** The title cut to TITLE_CHARS, for the strip; `title` is the full one, for the tooltip. */
  label: string
  state: ClaudeState | 'ended'
  /** The state in words beside the dot; absent for idle, which the empty circle shows on its own. */
  stateText?: string
  current: boolean
  run?: { number: number; duration: string }
}

const STATE_TEXT: Record<StripEntry['state'], string | undefined> = {
  working: 'working',
  waiting: 'waiting for you',
  idle: undefined,
  ended: 'session ended',
}

export function stripEntry(facts: StripFacts, nowMs: number): StripEntry {
  const entry: StripEntry = {
    number: facts.number,
    title: facts.title,
    label: shortTitle(facts.title, TITLE_CHARS),
    state: facts.sessionLive ? facts.claude : 'ended',
    current: facts.current,
  }
  const stateText = STATE_TEXT[entry.state]
  if (stateText) entry.stateText = stateText
  if (facts.running) entry.run = { number: facts.running.number, duration: runDuration(facts.running.startedAt, nowMs) }
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
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

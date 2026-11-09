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
  state: ClaudeState | 'ended'
  current: boolean
  run?: { number: number; duration: string }
}

export function stripEntry(facts: StripFacts, nowMs: number): StripEntry {
  const entry: StripEntry = {
    number: facts.number,
    title: facts.title,
    state: facts.sessionLive ? facts.claude : 'ended',
    current: facts.current,
  }
  if (facts.running) entry.run = { number: facts.running.number, duration: runDuration(facts.running.startedAt, nowMs) }
  return entry
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

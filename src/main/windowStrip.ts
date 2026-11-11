// The analysis strip along the window's edge: its entries, its settings and its side.
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { CLAUDE_STATE, readClaudeState } from '../core/claudeState.ts'
import { parseRunStatus } from '../core/runs.ts'
import type { Settings } from '../core/settings.ts'
import { stripEntry } from '../core/strip.ts'
import { CHANNELS } from '../shared/ipc.ts'
import type { SettingsView, StripView } from '../shared/ipc.ts'
import { RUN_STATUS } from './runFiles.ts'
import { analysisRoot, updateSettings } from './settings.ts'
import { layout } from './windowFrame.ts'
import { broadcast, ctxForPath, sendStrip, windowState } from './windowState.ts'

export const STRIP_MS = 1000

const readOptional = (path: string): Promise<string | undefined> => readFile(path, 'utf8').catch(() => undefined)

/** Sends the strip one entry per open analysis: its title, Claude's state and the run in progress. */
export async function refreshStrip() {
  const h = windowState.host
  if (!h) return
  const now = Date.now()
  const entries = await Promise.all(
    h.set.paths.map(async (path, i) => {
      const ctx = ctxForPath(path)
      const [claude, runs] = await Promise.all([readOptional(join(path, CLAUDE_STATE)), readOptional(join(path, RUN_STATUS))])
      return stripEntry(
        {
          number: i + 1,
          title: ctx?.analysis?.title ?? path,
          claude: readClaudeState(claude),
          // A session not started yet (the view is still loading) counts as live.
          sessionLive: !ctx?.session || ctx.session.flow.state() !== 'exited',
          running: parseRunStatus(runs ?? '').running,
          current: !h.picker && path === h.set.current,
        },
        now,
        h.stripPrefs.show,
      )
    }),
  )
  if (windowState.host === h) sendStrip(CHANNELS.stripEntries, { side: h.stripPrefs.side, entries } satisfies StripView)
}

/** Sends saved settings to every analysis, and lays the strip out by them. */
export function publishSettings(settings: Settings, root: string | undefined) {
  broadcast(CHANNELS.settingsChanged, { root, tabs: settings.tabs, strip: settings.strip } satisfies SettingsView)
  const host = windowState.host
  if (!host) return
  host.stripPrefs = settings.strip
  layout()
  void refreshStrip()
}

/** The palette's Move analysis strip: bottom to left and back, saved as Settings > Strip's side. */
export function toggleStripSide() {
  void updateSettings(s => ({ ...s, strip: { ...s.strip, side: s.strip.side === 'bottom' ? 'left' : 'bottom' } }))
    .then(async settings => {
      publishSettings(settings, await analysisRoot())
    })
    .catch((err: unknown) => {
      console.error('Could not save the strip side', err)
    })
}

// The state hook's work as a function of its input, so tests can call it directly (state.ts reads stdin and calls it).
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { CLAUDE_STATE, claudeStateFile, claudeStateForHook } from '../core/claudeState.ts'

/** Records the state a hook event moves Claude to, in the analysis folder. Outside an Assay session, or for an event that says nothing, it does nothing. */
export async function recordState(input: Record<string, unknown>, analysis: string | undefined, now: Date): Promise<void> {
  const state = claudeStateForHook(input)
  if (!analysis || !state) return
  const file = join(analysis, CLAUDE_STATE)
  const temp = `${file}.${String(process.pid)}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    // Renamed into place, so main never reads half a file.
    await writeFile(temp, claudeStateFile(state, now))
    await rename(temp, file)
  } catch {
    // The strip shows a stale state; never fail Claude's turn over it.
  }
}

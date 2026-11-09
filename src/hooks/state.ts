// Every hook event that changes what Claude is doing (plugin/hooks/hooks.json) records it for the analysis strip.
// Writes nothing back, so it never changes the prompt or the tool call. Outside an Assay session it does nothing.
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { CLAUDE_STATE, claudeStateFile, claudeStateForHook } from '../core/claudeState.ts'
import { readInput } from './io.ts'

const analysis = process.env.ASSAY_ANALYSIS
const state = claudeStateForHook(await readInput())
if (analysis && state) {
  const file = join(analysis, CLAUDE_STATE)
  const temp = `${file}.${process.pid}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    // Renamed into place, so main never reads half a file.
    await writeFile(temp, claudeStateFile(state, new Date()))
    await rename(temp, file)
  } catch {
    // The strip shows a stale state; never fail Claude's turn over it.
  }
}
